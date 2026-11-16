import { and, asc, eq, gt, isNull, notExists, type SQL } from 'drizzle-orm'

import { NotFoundError } from '../../errors.ts'
import { rulesFindings, type RuleFinding } from '../../scoring/rules-pass.ts'
import type { RulesPassInput } from '../../schemas/rules-pass.ts'
import { criteriaSet, requirement } from '../schema/criteria.ts'
import { posting } from '../schema/postings.ts'
import { workFormat } from '../schema/registries.ts'
import { postingScore } from '../schema/scores.ts'
import { findUsableCriteriaSet } from './criteria.ts'
import type { Db } from './db.ts'
import { scorePosting } from './scores.ts'

/** The note every score the rules pass writes carries, so its scores can be told from an agent's. */
export const RULES_PASS_NOTE = 'rules pass: rated from the title and place alone'

/** A posting the pass looked at, and what its rules found; no finding means it is left for an agent. */
export type RulesPassItem = {
  readonly postingId: number
  readonly postingKey: string
  readonly roleTitle: string
  readonly findings: readonly RuleFinding[]
}

export type RulesPassResult = {
  readonly criteriaSetId: number
  readonly written: boolean
  readonly examined: number
  readonly blocked: readonly RulesPassItem[]
  readonly left: readonly Omit<RulesPassItem, 'findings'>[]
  /** Pass this as `afterPostingId` for the next batch; null when this batch reached the end. */
  readonly nextAfterPostingId: number | null
}

/** The default criteria set's id, or `NotFoundError` when no active set is the default. */
async function defaultSetId(db: Db): Promise<number> {
  const [found] = await db
    .select({ id: criteriaSet.id })
    .from(criteriaSet)
    .where(and(eq(criteriaSet.isDefault, true), isNull(criteriaSet.archivedAt)))
  if (!found) throw new NotFoundError('criteria set', 'default')
  return found.id
}

/** Postings with no score under the set, in id order after the cursor, with the fields the rules read. */
async function unscoredPostings(db: Db, criteriaSetId: number, input: RulesPassInput) {
  const scored = db
    .select({ id: postingScore.id })
    .from(postingScore)
    .where(and(eq(postingScore.postingId, posting.id), eq(postingScore.criteriaSetId, criteriaSetId)))
  const conditions: SQL[] = [notExists(scored)]
  if (input.afterPostingId !== undefined) conditions.push(gt(posting.id, input.afterPostingId))
  return db
    .select({
      postingId: posting.id,
      postingKey: posting.postingKey,
      roleTitle: posting.roleTitle,
      country: posting.country,
      city: posting.city,
      workFormat: workFormat.label,
    })
    .from(posting)
    .leftJoin(workFormat, eq(workFormat.id, posting.workFormatId))
    .where(and(...conditions))
    .orderBy(asc(posting.id))
    .limit(input.limit)
}

/** Stores one score per blocked posting, rating only the requirements a rule rated 0. */
async function writeBlocked(db: Db, criteriaSetId: number, blocked: readonly RulesPassItem[]): Promise<void> {
  if (blocked.length === 0) return
  await db.transaction(async (tx) => {
    for (const item of blocked) {
      await scorePosting(tx, {
        postingId: item.postingId,
        criteriaSetId,
        ratings: item.findings.map((finding) => ({
          requirementId: finding.requirementId,
          coverage: 0,
          confidence: 'supported' as const,
          evidence: finding.evidence,
        })),
        penalties: [],
        note: RULES_PASS_NOTE,
      })
    }
  })
}

/**
 * The rules pass: rates postings against a criteria set from their own fields, with no agent.
 * It looks at up to `limit` postings that have no score under the set, after the cursor. A
 * posting a rule rates 0 is `blocked`; with `write`, it gets a score that rates only those
 * requirements, so its gate blocks it and its rules band is skip. Every other posting is
 * `left`, unscored, for an agent to read: the rules settle only what the title and place
 * fields settle. All the writes of one run go in one transaction. An unknown or archived set
 * is refused before anything is read.
 */
export async function runRulesPass(db: Db, input: RulesPassInput): Promise<RulesPassResult> {
  const criteriaSetId = input.criteriaSetId ?? (await defaultSetId(db))
  await findUsableCriteriaSet(db, criteriaSetId)
  const requirements = await db
    .select({ id: requirement.id, key: requirement.key, rules: requirement.rules })
    .from(requirement)
    .where(eq(requirement.criteriaSetId, criteriaSetId))
    .orderBy(asc(requirement.sort), asc(requirement.id))
  const candidates = await unscoredPostings(db, criteriaSetId, input)

  const examined = candidates.map(({ postingId, postingKey, roleTitle, ...place }) => ({
    postingId,
    postingKey,
    roleTitle,
    findings: rulesFindings({ roleTitle, ...place }, requirements),
  }))
  const blocked = examined.filter((item) => item.findings.length > 0)
  const left = examined.filter((item) => item.findings.length === 0).map(({ findings: _none, ...item }) => item)
  if (input.write) await writeBlocked(db, criteriaSetId, blocked)

  const last = candidates.at(-1)
  return {
    criteriaSetId,
    written: input.write,
    examined: examined.length,
    blocked,
    left,
    nextAfterPostingId: candidates.length === input.limit && last !== undefined ? last.postingId : null,
  }
}
