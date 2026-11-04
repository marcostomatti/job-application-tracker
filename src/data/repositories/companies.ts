import { eq, type InferSelectModel } from 'drizzle-orm'

import { NotFoundError } from '../../errors.ts'
import type { CompanyInput } from '../../schemas/postings.ts'
import { company, normaliseName } from '../schema/postings.ts'
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
