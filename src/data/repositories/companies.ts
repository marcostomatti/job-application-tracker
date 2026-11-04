import { alias } from 'drizzle-orm/pg-core'
import { and, asc, eq, inArray, type InferSelectModel } from 'drizzle-orm'

import { ConflictError, NotFoundError } from '../../errors.ts'
import type { CompanyMergeInput, CompanyPatch } from '../../schemas/companies.ts'
import type { CompanyInput } from '../../schemas/postings.ts'
import { isForeignKeyViolation, isUniqueViolation } from '../driver-faults.ts'
import { company, normaliseName, posting } from '../schema/postings.ts'
import type { Db } from './db.ts'

export type Company = InferSelectModel<typeof company>

/**
 * The company for a name, created when no company matches it. Two names match when
 * `normaliseName` gives them one key, so "Cafe Ltd" and "Café LTD." share a row, and the
 * row keeps the spelling it was first seen under.
 *
 * `normaliseName` folds only Latin diacritics and plain case, so it is a good match for the
 * names a job board prints and a poor one across scripts: a letter such as the Danish slashed
 * o has no decomposition and stays distinct from its plain form, German sharp s is not folded
 * to "ss", and a name in two scripts is two companies. Those are separate rows, which is the
 * safe error: a merge of two employers is hard to undo, a split is one edit.
 *
 * A name that matches returns the stored row unchanged, including its `nameUnresolved` flag:
 * the same placeholder named twice is still the one placeholder, and a call must not flip
 * what an earlier one decided. The insert is `ON CONFLICT DO NOTHING` followed by a read, so
 * two callers racing on one new employer both get the one row that won.
 */
export async function upsertCompany(db: Db, input: CompanyInput): Promise<Company> {
  const nameNorm = normaliseName(input.name)
  const [created] = await db
    .insert(company)
    .values({ name: input.name, nameNorm, nameUnresolved: input.nameUnresolved ?? false })
    .onConflictDoNothing({ target: company.nameNorm })
    .returning()
  if (created) return created

  const [existing] = await db.select().from(company).where(eq(company.nameNorm, nameNorm))
  if (!existing) throw new NotFoundError('company', input.name)
  return existing
}

/** One company by id, for a read that already holds a posting naming it. */
export async function findCompany(db: Db, id: number): Promise<Company> {
  const [found] = await db.select().from(company).where(eq(company.id, id))
  if (!found) throw new NotFoundError('company', id)
  return found
}

/** The constraint names Postgres reports when a rename or a merge would duplicate a row. */
const NAME_CONSTRAINT = 'company_name_norm_unique'
const ROLE_CONSTRAINT = 'posting_company_role_disambiguator_unique'
const POSTING_COMPANY_FK = 'posting_company_id_company_id_fk'

/** The company that holds a normalised name, if any. */
async function holderOf(db: Db, nameNorm: string): Promise<Company | undefined> {
  const [holder] = await db.select().from(company).where(eq(company.nameNorm, nameNorm))
  return holder
}

/** The refusal of a name another company holds; its message names that company and the fix. */
function nameTaken(name: string, holderId: number | undefined, cause?: unknown): ConflictError {
  const holder = holderId === undefined ? 'another company' : `company ${holderId}`
  return new ConflictError('company name', name, {
    cause,
    message: `the company name "${name}" is held by ${holder}; if the two are one employer, merge them with company_merge`,
  })
}

/**
 * Changes the named fields of one company and returns it as stored. A new `name` recomputes
 * `name_norm`, so later imports under the new spelling reach this row. A name whose key another
 * company holds is a conflict naming that company and `company_merge`; a new spelling of the
 * row's own key, such as a change of case, is a plain rename. An empty patch returns the row.
 */
export async function updateCompany(db: Db, id: number, patch: CompanyPatch): Promise<Company> {
  const stored = await findCompany(db, id)
  const columns = {
    ...(patch.name === undefined ? {} : { name: patch.name, nameNorm: normaliseName(patch.name) }),
    ...(patch.nameUnresolved === undefined ? {} : { nameUnresolved: patch.nameUnresolved }),
  }
  if (Object.keys(columns).length === 0) return stored

  if (columns.nameNorm !== undefined && columns.nameNorm !== stored.nameNorm) {
    const holder = await holderOf(db, columns.nameNorm)
    if (holder) throw nameTaken(patch.name ?? '', holder.id)
  }
  try {
    const [updated] = await db.update(company).set(columns).where(eq(company.id, id)).returning()
    if (!updated) throw new NotFoundError('company', id)
    return updated
  } catch (error) {
    // A rename that raced another company to the same key. The holder is not read again: when
    // `db` is a transaction it is aborted now, and a read would replace this conflict with its own fault.
    if (!isUniqueViolation(error, NAME_CONSTRAINT)) throw error
    throw nameTaken(patch.name ?? '', undefined, error)
  }
}

/** What a merge did: the company kept, how many postings moved to it, and the id removed. */
export type CompanyMergeResult = {
  readonly company: Company
  readonly postingsMoved: number
  readonly removedCompanyId: number
}

/** The postings that name one role at both companies, as `from id → into id` pairs. */
async function sharedRoles(db: Db, input: CompanyMergeInput): Promise<Array<{ fromId: number; intoId: number }>> {
  const into = alias(posting, 'into_posting')
  return db
    .select({ fromId: posting.id, intoId: into.id })
    .from(posting)
    .innerJoin(
      into,
      and(
        eq(into.companyId, input.intoCompanyId),
        eq(into.roleNorm, posting.roleNorm),
        eq(into.disambiguator, posting.disambiguator),
      ),
    )
    .where(eq(posting.companyId, input.fromCompanyId))
    .orderBy(posting.id)
}

/**
 * Locks the two companies of a merge, in id order, and returns the one kept. An id with no
 * company is a not-found error naming it.
 */
async function lockBoth(tx: Db, input: CompanyMergeInput): Promise<Company> {
  const ids = [input.intoCompanyId, input.fromCompanyId]
  const locked = await tx.select().from(company).where(inArray(company.id, ids)).orderBy(asc(company.id)).for('update')
  const kept = locked.find((row) => row.id === input.intoCompanyId)
  if (!kept) throw new NotFoundError('company', input.intoCompanyId)
  if (!locked.some((row) => row.id === input.fromCompanyId)) throw new NotFoundError('company', input.fromCompanyId)
  return kept
}

/** The refusal of a merge that would put one role twice at one company. */
function rolesShared(pairs: ReadonlyArray<{ fromId: number; intoId: number }>, cause?: unknown): ConflictError {
  const named = pairs.map((pair) => `posting ${pair.fromId} and posting ${pair.intoId}`).join(', ')
  const which = named === '' ? 'a posting at each company' : named
  return new ConflictError('posting', which, {
    cause,
    message:
      `the merge would put one role twice at one company: ${which}. ` +
      'Give one of each pair a disambiguator with posting_update, or reject one, then merge again',
  })
}

/**
 * Moves every posting of `fromCompanyId` to `intoCompanyId`, deletes `fromCompanyId`, and says
 * how many postings moved, all in one transaction. The company kept keeps its own name and
 * `nameUnresolved`. A role both companies hold, by `role_norm` and `disambiguator`, stops the
 * merge before anything is written, as a conflict naming the postings at each side. The removed
 * company leaves no alias: a later import under its spelling creates it again.
 *
 * Both company rows are locked first, in id order, so a posting added under either company
 * waits for the merge instead of slipping between the move and the delete, and two merges of
 * one pair queue rather than deadlock.
 */
export async function mergeCompanies(db: Db, input: CompanyMergeInput): Promise<CompanyMergeResult> {
  return db.transaction(async (tx) => {
    const kept = await lockBoth(tx, input)

    const shared = await sharedRoles(tx, input)
    if (shared.length > 0) throw rolesShared(shared)

    try {
      const moved = await tx
        .update(posting)
        .set({ companyId: input.intoCompanyId })
        .where(eq(posting.companyId, input.fromCompanyId))
        .returning({ id: posting.id })
      await tx.delete(company).where(eq(company.id, input.fromCompanyId))
      return { company: kept, postingsMoved: moved.length, removedCompanyId: input.fromCompanyId }
    } catch (error) {
      if (isForeignKeyViolation(error, POSTING_COMPANY_FK)) {
        throw new ConflictError('company', String(input.fromCompanyId), {
          cause: error,
          message: `a posting was added to company ${input.fromCompanyId} during the merge, which was not written; merge again`,
        })
      }
      // A role added at either side after the check: the key refuses it. The transaction is aborted,
      // so the pairs cannot be read in it, and the message names none.
      if (!isUniqueViolation(error, ROLE_CONSTRAINT)) throw error
      throw rolesShared([], error)
    }
  })
}
