import { and, desc, eq, lt, sql, type InferSelectModel, type SQL } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'

import { ConflictError } from '../../errors.ts'
import type { Requirement, ScoreInput } from '../../entities/scoring.ts'
import { REQUIREMENT_KINDS, type RequirementKind } from '../../schemas/discriminators.ts'
import { detourIdsOf, type PenaltyInput, type RatingInput, type ScorePostingInput } from '../../schemas/scores.ts'
import { scoreAgainstSet, type ScoreResult } from '../../scoring/score-against-set.ts'
import { isForeignKeyViolation } from '../driver-faults.ts'
import { criteriaSet, requirement } from '../schema/criteria.ts'
import { postingPenalty, postingRating, postingRatingDetour, postingScore } from '../schema/scores.ts'
import { findUsableCriteriaSet, getRequirements, nonSupersededSetIds, type CriteriaSetRow, type RequirementRow } from './criteria.ts'
import type { Db } from './db.ts'
import { assertPostingExists } from './posting-exists.ts'
import { pickDefined } from './pick-defined.ts'
import { assertNotArchived } from './registries.ts'

type StoredScore = InferSelectModel<typeof postingScore>
type NewScore = typeof postingScore.$inferInsert

/**
 * A stored score as a caller reads it: the row, plus the keys of the requirements the table
 * stores by id (`limiterRequirementId`, `runnerUpRequirementId`), so a reader can name the
 * limiter without a second lookup. Both keys are null exactly when the matching id is.
 *
 * `criteriaSetName` and `criteriaSetVersion` are the scored set's own, so a reader can tell
 * which lens a row belongs to and which of a name's versions it came from, which is what the
 * across-sets rule (spec section 8) is stated in, without a second call to read the sets.
 */
export type ScoreRow = StoredScore & {
  readonly limiterKey: string | null
  readonly runnerUpKey: string | null
  readonly criteriaSetName: string
  readonly criteriaSetVersion: number
}

/**
 * The columns `scorePosting` writes to a score row, in one place: what the scoring function
 * returned, mapped to the table's names, and the note. The posting, the set, the day and
 * `isRescore` are set by the code that owns them. The write copies exactly these keys.
 */
const SCORE_COLUMNS = [
  'overall',
  'floor',
  'ceiling',
  'limiterRequirementId',
  'limiterCoverage',
  'limiterIsUnknown',
  'runnerUpRequirementId',
  'recommendApply',
  'note',
] as const satisfies readonly (keyof NewScore)[]

type ScoreValues = Pick<NewScore, (typeof SCORE_COLUMNS)[number]>

const limiterRequirement = alias(requirement, 'limiter_requirement')
const runnerUpRequirement = alias(requirement, 'runner_up_requirement')

/** The stored kind as the discriminator the scoring function reads. The table's CHECK allows nothing else, so a miss is a broken invariant. */
function narrowKind(kind: string): RequirementKind {
  const found = REQUIREMENT_KINDS.find((candidate) => candidate === kind)
  if (found === undefined) throw new Error('A stored requirement has a kind the requirement table does not allow.')
  return found
}

/** A stored requirement as the scoring function reads it, which parses its whole input itself. Layers only group a report, so the id stands in for the key. */
function toScoringRequirement(row: RequirementRow): Requirement {
  return {
    key: row.key,
    layerKey: row.layerId === null ? '' : String(row.layerId),
    kind: narrowKind(row.kind),
    weight: row.weight,
    label: row.label,
  }
}

/** The coverage a rating gave one detour of its requirement; null when it gave none. */
function coverageOfDetour(rating: RatingInput | undefined, detourId: number): number | null {
  return rating?.detours?.find((entry) => entry.detourId === detourId)?.coverage ?? null
}

/**
 * What `scoreAgainstSet` reads, built from the stored set and what the caller rated. Ratings and
 * penalties are keyed by requirement id and penalty kind id in the table and by key in the
 * function, so each id is translated to its key here. A rating naming a requirement outside the
 * set has no key and takes no part in the arithmetic; the composite key on `posting_rating`
 * then refuses the row when it is written, which rolls the whole score back.
 *
 * A detour's coverage is the one the caller gave under the rating of its requirement, and null
 * (not rated) when it gave none, so a declared detour only counts once someone has assessed it.
 * The penalty kind has no key column, so its id stands in; the function only sums the amounts.
 */
function buildScoreInput(
  set: CriteriaSetRow,
  requirements: readonly RequirementRow[],
  ratings: readonly RatingInput[],
  penalties: readonly PenaltyInput[],
): ScoreInput {
  const keyById = new Map(requirements.map((row) => [row.id, row.key]))
  const ratingByRequirementId = new Map(ratings.map((rating) => [rating.requirementId, rating]))
  return {
    requirements: requirements.map(toScoringRequirement),
    ratings: ratings.flatMap((rating) => {
      const requirementKey = keyById.get(rating.requirementId)
      return requirementKey === undefined ? [] : [{ requirementKey, coverage: rating.coverage, confidence: rating.confidence }]
    }),
    detours: requirements.flatMap((row) =>
      row.detours.map((entry) => ({
        requirementKey: row.key,
        label: entry.label,
        discount: entry.discount,
        coverage: coverageOfDetour(ratingByRequirementId.get(row.id), entry.id),
      })),
    ),
    penalties: penalties.map((penalty) => ({ kindKey: String(penalty.penaltyKindId), amount: penalty.amount })),
    applyThreshold: set.applyThreshold,
  }
}

/** The score columns for a result, with the keys it names mapped back to requirement ids. */
function toScoreValues(result: ScoreResult, requirements: readonly RequirementRow[], note: string | undefined): ScoreValues {
  const idByKey = new Map(requirements.map((row) => [row.key, row.id]))
  const idOf = (key: string | null): number | null => {
    if (key === null) return null
    const id = idByKey.get(key)
    if (id === undefined) throw new Error('The scoring function named a requirement key the set does not hold.')
    return id
  }
  return {
    overall: result.overall,
    floor: result.floor,
    ceiling: result.ceiling,
    limiterRequirementId: idOf(result.limiterKey),
    limiterCoverage: result.limiterCoverage,
    limiterIsUnknown: result.limiterIsUnknown,
    runnerUpRequirementId: idOf(result.runnerUpKey),
    recommendApply: result.recommendApply,
    note: note ?? null,
  }
}

/** Whether this posting was scored against this set on an earlier day, which is what makes a new row a re-score. */
async function hasEarlierScore(db: Db, postingId: number, criteriaSetId: number): Promise<boolean> {
  const [found] = await db
    .select({ id: postingScore.id })
    .from(postingScore)
    .where(
      and(
        eq(postingScore.postingId, postingId),
        eq(postingScore.criteriaSetId, criteriaSetId),
        lt(postingScore.scoredAt, sql`CURRENT_DATE`),
      ),
    )
    .limit(1)
  return found !== undefined
}

/**
 * Writes today's score row for the posting and set: inserts it, or replaces the numbers on the
 * row that already exists for today. One statement, so two callers scoring the same day cannot
 * both insert and the loser fail on the unique key; the second waits for the first's row, then
 * updates it. A same-day update leaves `isRescore` as it was, because it does not change whether
 * an earlier day's score exists.
 */
async function upsertScoreRow(db: Db, input: ScorePostingInput, values: ScoreValues): Promise<StoredScore> {
  const isRescore = await hasEarlierScore(db, input.postingId, input.criteriaSetId)
  const [written] = await db
    .insert(postingScore)
    .values({ postingId: input.postingId, criteriaSetId: input.criteriaSetId, isRescore, ...pickDefined(values, SCORE_COLUMNS) })
    .onConflictDoUpdate({
      target: [postingScore.postingId, postingScore.criteriaSetId, postingScore.scoredAt],
      set: pickDefined(values, SCORE_COLUMNS),
    })
    .returning()
  if (!written) throw new Error('The score upsert returned no row.')
  return written
}

async function insertRatings(db: Db, score: StoredScore, ratings: readonly RatingInput[]): Promise<void> {
  if (ratings.length === 0) return
  await db.insert(postingRating).values(
    ratings.map((rating) => ({
      scoreId: score.id,
      criteriaSetId: score.criteriaSetId,
      requirementId: rating.requirementId,
      coverage: rating.coverage,
      confidence: rating.confidence,
      evidence: rating.evidence ?? null,
    })),
  )
}

async function insertDetourCoverages(db: Db, score: StoredScore, ratings: readonly RatingInput[]): Promise<void> {
  const rows = ratings.flatMap((rating) =>
    (rating.detours ?? []).map((entry) => ({
      scoreId: score.id,
      requirementId: rating.requirementId,
      detourId: entry.detourId,
      coverage: entry.coverage,
    })),
  )
  if (rows.length > 0) await db.insert(postingRatingDetour).values(rows)
}

async function insertPenalties(db: Db, score: StoredScore, penalties: readonly PenaltyInput[]): Promise<void> {
  if (penalties.length === 0) return
  await db.insert(postingPenalty).values(
    penalties.map((penalty) => ({
      scoreId: score.id,
      penaltyKindId: penalty.penaltyKindId,
      amount: penalty.amount,
      reason: penalty.reason ?? null,
    })),
  )
}

/**
 * Makes the ratings, detour coverages and penalties of a score exactly the ones given. A
 * same-day re-score replaces what the row held rather than merging into it, because the stored
 * numbers were computed from these alone; a leftover row from the earlier call would sit beside
 * a score that never saw it. A detour coverage hangs off its rating by a cascading key, so
 * deleting the ratings deletes the coverages with them.
 */
async function replaceRatingsAndPenalties(db: Db, score: StoredScore, input: ScorePostingInput): Promise<void> {
  await db.delete(postingRating).where(eq(postingRating.scoreId, score.id))
  await db.delete(postingPenalty).where(eq(postingPenalty.scoreId, score.id))
  await insertRatings(db, score, input.ratings)
  await insertDetourCoverages(db, score, input.ratings)
  await insertPenalties(db, score, input.penalties)
}

const REQUIREMENT_OUTSIDE_SET = 'posting_rating_set_requirement_fk'
const DETOUR_OF_OTHER_REQUIREMENT = 'posting_rating_detour_detour_fk'

/**
 * Types the two foreign-key faults a caller can cause, and leaves every other error as it was.
 * The keys stay the guarantee (the database, not this code, decides membership); this only turns
 * the driver's fault, whose message repeats the failed statement, into an error that carries no
 * SQL. The driver fault stays on `cause`.
 */
function typeMembershipFault(error: unknown, input: ScorePostingInput): unknown {
  if (isForeignKeyViolation(error, REQUIREMENT_OUTSIDE_SET)) {
    return new ConflictError('criteria set', String(input.criteriaSetId), {
      message: `a rating names a requirement that is not in criteria set ${input.criteriaSetId}`,
      cause: error,
    })
  }
  if (isForeignKeyViolation(error, DETOUR_OF_OTHER_REQUIREMENT)) {
    return new ConflictError('requirement detour', detourIdsOf(input.ratings).join(', '), {
      message: 'a detour coverage names something that is not a detour of the requirement it is rated under',
      cause: error,
    })
  }
  return error
}

/**
 * Scores a posting against a criteria set and stores the result: the row, its ratings and its
 * penalties, in one transaction. `scoreAgainstSet` does all the arithmetic and names the limiter;
 * this function loads its input, translates requirement ids and keys in both directions, and
 * stores what came back. It is the only writer of `posting_score`, so a stored limiter is always
 * one the function returned, and nothing recomputes a score from stored columns.
 *
 * A null coverage is stored as null: not rated, which is not zero. A call on the same day as
 * an existing score for the same set replaces that row, its ratings and its penalties; a call on a
 * later day writes a new row marked `isRescore`. A penalty naming an archived kind, or a score
 * against an archived criteria set, is refused before anything is written (`ArchivedError`).
 * A rating naming a requirement outside the set, or a detour coverage naming a detour of another
 * requirement, is refused by the database's composite keys and surfaces as a `ConflictError`. The function moves no posting and writes no stage event: a
 * recommendation is acted on by whoever composes this call with the pipeline.
 */
export async function scorePosting(db: Db, input: ScorePostingInput): Promise<ScoreRow> {
  try {
    return await db.transaction(async (tx) => {
      await assertPostingExists(tx, input.postingId)
      const set = await findUsableCriteriaSet(tx, input.criteriaSetId)
      for (const penalty of input.penalties) await assertNotArchived(tx, 'penalty_kind', penalty.penaltyKindId)
      const requirements = await getRequirements(tx, set.id)
      const result = scoreAgainstSet(buildScoreInput(set, requirements, input.ratings, input.penalties))
      const score = await upsertScoreRow(tx, input, toScoreValues(result, requirements, input.note))
      await replaceRatingsAndPenalties(tx, score, input)
      return { ...score, limiterKey: result.limiterKey, runnerUpKey: result.runnerUpKey, criteriaSetName: set.name, criteriaSetVersion: set.version }
    })
  } catch (error) {
    throw typeMembershipFault(error, input)
  }
}

/** Every score of a posting that meets the condition, newest first (the day scored, then the row id), with its limiter keys and its set's name and version. */
async function readScoreRows(db: Db, postingId: number, condition: SQL | undefined): Promise<ScoreRow[]> {
  const rows = await db
    .select({
      score: postingScore,
      limiterKey: limiterRequirement.key,
      runnerUpKey: runnerUpRequirement.key,
      criteriaSetName: criteriaSet.name,
      criteriaSetVersion: criteriaSet.version,
    })
    .from(postingScore)
    .innerJoin(criteriaSet, eq(criteriaSet.id, postingScore.criteriaSetId))
    .leftJoin(limiterRequirement, eq(limiterRequirement.id, postingScore.limiterRequirementId))
    .leftJoin(runnerUpRequirement, eq(runnerUpRequirement.id, postingScore.runnerUpRequirementId))
    .where(and(eq(postingScore.postingId, postingId), condition))
    .orderBy(desc(postingScore.scoredAt), desc(postingScore.id))
  return rows.map(({ score, ...rest }) => ({ ...score, ...rest }))
}

/**
 * Every score of a posting, newest first (the day scored, then the row id). Each row carries
 * its `criteriaSetId`, name and version, so a caller in `perspective` mode groups the list by
 * set and the order inside each group is still newest first. A posting that does not exist is
 * `NotFoundError`, so "never scored" and "no such posting" stay different answers.
 */
export async function getScoreHistory(db: Db, postingId: number): Promise<ScoreRow[]> {
  await assertPostingExists(db, postingId)
  return readScoreRows(db, postingId, undefined)
}

/**
 * The scores that stand today, newest first: the latest score of each non-superseded criteria
 * set (see `nonSupersededSetIds`, which is the spec's section 8 rule). For a set name that is
 * its highest version, and within it the latest day. A posting scored under v1 and v2 of one
 * name gives one row, v2's; one scored only under v1, once v2 exists, gives none for that name.
 * This is what the "+n" chip counts. A set archived since it scored still stands, because an
 * archived set is hidden from new use and not from what it already judged.
 */
export async function getBestScores(db: Db, postingId: number): Promise<ScoreRow[]> {
  await assertPostingExists(db, postingId)
  const latestBySet = new Map<number, ScoreRow>()
  for (const row of await readScoreRows(db, postingId, sql`${postingScore.criteriaSetId} in ${nonSupersededSetIds()}`)) {
    if (!latestBySet.has(row.criteriaSetId)) latestBySet.set(row.criteriaSetId, row)
  }
  return [...latestBySet.values()]
}
