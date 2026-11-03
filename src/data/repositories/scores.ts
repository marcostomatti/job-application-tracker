import { and, desc, eq, lt, sql, type InferSelectModel } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'

import { NotFoundError } from '../../errors.ts'
import type { Requirement, ScoreInput } from '../../entities/scoring.ts'
import { RequirementSchema } from '../../schemas/scoring.ts'
import type { PenaltyInput, RatingInput, ScorePositionInput } from '../../schemas/scores.ts'
import { scoreAgainstSet, type ScoreResult } from '../../scoring/score-against-set.ts'
import { requirement } from '../schema/criteria.ts'
import { position } from '../schema/positions.ts'
import { positionPenalty, positionRating, positionScore } from '../schema/scores.ts'
import { findCriteriaSet, getRequirements, type CriteriaSetRow, type RequirementRow } from './criteria.ts'
import type { Db } from './db.ts'
import { pickDefined } from './pick-defined.ts'
import { assertNotArchived } from './registries.ts'

type StoredScore = InferSelectModel<typeof positionScore>
type NewScore = typeof positionScore.$inferInsert

/**
 * A stored score as a caller reads it: the row, plus the keys of the requirements the table
 * stores by id (`limiterRequirementId`, `runnerUpRequirementId`), so a reader can name the
 * limiter without a second lookup. Both keys are null exactly when the matching id is.
 */
export type ScoreRow = StoredScore & {
  readonly limiterKey: string | null
  readonly runnerUpKey: string | null
}

/**
 * The columns `scorePosition` writes to a score row, in one place: what the scoring function
 * returned, mapped to the table's names, and the note. The position, the set, the day and
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

async function assertPositionExists(db: Db, positionId: number): Promise<void> {
  const [found] = await db.select({ id: position.id }).from(position).where(eq(position.id, positionId))
  if (!found) throw new NotFoundError('position', positionId)
}

/** Narrows a stored requirement to what the scoring function reads. Layers only group a report, so the id stands in for the key. */
function toScoringRequirement(row: RequirementRow): Requirement {
  return RequirementSchema.parse({
    key: row.key,
    layerKey: row.layerId === null ? '' : String(row.layerId),
    kind: row.kind,
    weight: row.weight,
    label: row.label,
  })
}

/**
 * What `scoreAgainstSet` reads, built from the stored set and what the caller rated. Ratings and
 * penalties are keyed by requirement id and penalty kind id in the table and by key in the
 * function, so each id is translated to its key here. A rating naming a requirement outside the
 * set has no key and takes no part in the arithmetic; the composite key on `position_rating`
 * then refuses the row when it is written, which rolls the whole score back.
 *
 * Detours carry a null coverage: a detour's coverage would be a per-position fact, and no table
 * stores one, so a detour is a way round nobody has assessed and cannot raise a stored score.
 * The penalty kind has no key column, so its id stands in; the function only sums the amounts.
 */
function buildScoreInput(
  set: CriteriaSetRow,
  requirements: readonly RequirementRow[],
  ratings: readonly RatingInput[],
  penalties: readonly PenaltyInput[],
): ScoreInput {
  const keyById = new Map(requirements.map((row) => [row.id, row.key]))
  return {
    requirements: requirements.map(toScoringRequirement),
    ratings: ratings.flatMap((rating) => {
      const requirementKey = keyById.get(rating.requirementId)
      return requirementKey === undefined ? [] : [{ requirementKey, coverage: rating.coverage, confidence: rating.confidence }]
    }),
    detours: requirements.flatMap((row) =>
      row.detours.map((entry) => ({ requirementKey: row.key, label: entry.label, discount: entry.discount, coverage: null })),
    ),
    penalties: penalties.map((penalty) => ({ kindKey: String(penalty.penaltyKindId), amount: penalty.amount })),
    applyThreshold: set.applyThreshold,
  }
}

/** The score columns for a result, with the keys it names mapped back to requirement ids. */
function toScoreValues(result: ScoreResult, requirements: readonly RequirementRow[], note: string | undefined): ScoreValues {
  const idByKey = new Map(requirements.map((row) => [row.key, row.id]))
  const idOf = (key: string | null): number | null => (key === null ? null : (idByKey.get(key) ?? null))
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

/** Whether this position was scored against this set on an earlier day, which is what makes a new row a re-score. */
async function hasEarlierScore(db: Db, positionId: number, criteriaSetId: number): Promise<boolean> {
  const [found] = await db
    .select({ id: positionScore.id })
    .from(positionScore)
    .where(
      and(
        eq(positionScore.positionId, positionId),
        eq(positionScore.criteriaSetId, criteriaSetId),
        lt(positionScore.scoredAt, sql`CURRENT_DATE`),
      ),
    )
    .limit(1)
  return found !== undefined
}

/**
 * Writes today's score row for the position and set: inserts it, or replaces the numbers on the
 * row that already exists for today. One statement, so two callers scoring the same day cannot
 * both insert and the loser fail on the unique key; the second waits for the first's row, then
 * updates it. A same-day update leaves `isRescore` as it was, because it does not change whether
 * an earlier day's score exists.
 */
async function upsertScoreRow(db: Db, input: ScorePositionInput, values: ScoreValues): Promise<StoredScore> {
  const isRescore = await hasEarlierScore(db, input.positionId, input.criteriaSetId)
  const [written] = await db
    .insert(positionScore)
    .values({ positionId: input.positionId, criteriaSetId: input.criteriaSetId, isRescore, ...pickDefined(values, SCORE_COLUMNS) })
    .onConflictDoUpdate({
      target: [positionScore.positionId, positionScore.criteriaSetId, positionScore.scoredAt],
      set: pickDefined(values, SCORE_COLUMNS),
    })
    .returning()
  if (!written) throw new Error('The score upsert returned no row.')
  return written
}

/**
 * Makes the ratings and penalties of a score exactly the ones given. A same-day re-score
 * replaces what the row held rather than merging into it, because the stored numbers were
 * computed from these ratings and these penalties alone; a leftover row from the earlier call
 * would sit beside a score that never saw it.
 */
async function replaceRatingsAndPenalties(db: Db, score: StoredScore, input: ScorePositionInput): Promise<void> {
  await db.delete(positionRating).where(eq(positionRating.scoreId, score.id))
  await db.delete(positionPenalty).where(eq(positionPenalty.scoreId, score.id))
  if (input.ratings.length > 0) {
    await db.insert(positionRating).values(
      input.ratings.map((rating) => ({
        scoreId: score.id,
        criteriaSetId: score.criteriaSetId,
        requirementId: rating.requirementId,
        coverage: rating.coverage,
        confidence: rating.confidence,
        evidence: rating.evidence ?? null,
      })),
    )
  }
  if (input.penalties.length > 0) {
    await db.insert(positionPenalty).values(
      input.penalties.map((penalty) => ({
        scoreId: score.id,
        penaltyKindId: penalty.penaltyKindId,
        amount: penalty.amount,
        reason: penalty.reason ?? null,
      })),
    )
  }
}

/**
 * Scores a position against a criteria set and stores the result: the row, its ratings and its
 * penalties, in one transaction. `scoreAgainstSet` does all the arithmetic and names the limiter;
 * this function loads its input, translates requirement ids and keys in both directions, and
 * stores what came back. It is the only writer of `position_score`, so a stored limiter is always
 * one the function returned, and nothing recomputes a score from stored columns.
 *
 * A null coverage is stored as null: not rated, which is not zero. A call on the same day as
 * an existing score for the same set replaces that row, its ratings and its penalties; a call on a
 * later day writes a new row marked `isRescore`. A penalty naming an archived kind is refused
 * before anything is written. The function moves no position and writes no stage event: a
 * recommendation is acted on by whoever composes this call with the pipeline.
 */
export async function scorePosition(db: Db, input: ScorePositionInput): Promise<ScoreRow> {
  return db.transaction(async (tx) => {
    await assertPositionExists(tx, input.positionId)
    const set = await findCriteriaSet(tx, input.criteriaSetId)
    for (const penalty of input.penalties) await assertNotArchived(tx, 'penalty_kind', penalty.penaltyKindId)
    const requirements = await getRequirements(tx, set.id)
    const result = scoreAgainstSet(buildScoreInput(set, requirements, input.ratings, input.penalties))
    const score = await upsertScoreRow(tx, input, toScoreValues(result, requirements, input.note))
    await replaceRatingsAndPenalties(tx, score, input)
    return { ...score, limiterKey: result.limiterKey, runnerUpKey: result.runnerUpKey }
  })
}

/**
 * Every score of a position, newest first (the day scored, then the row id). Each row carries
 * its `criteriaSetId`, so a caller in `perspective` mode groups the list by set and the order
 * inside each group is still newest first. A position that does not exist is `NotFoundError`,
 * so "never scored" and "no such position" stay different answers.
 */
export async function getScoreHistory(db: Db, positionId: number): Promise<ScoreRow[]> {
  await assertPositionExists(db, positionId)
  const rows = await db
    .select({ score: positionScore, limiterKey: limiterRequirement.key, runnerUpKey: runnerUpRequirement.key })
    .from(positionScore)
    .leftJoin(limiterRequirement, eq(limiterRequirement.id, positionScore.limiterRequirementId))
    .leftJoin(runnerUpRequirement, eq(runnerUpRequirement.id, positionScore.runnerUpRequirementId))
    .where(eq(positionScore.positionId, positionId))
    .orderBy(desc(positionScore.scoredAt), desc(positionScore.id))
  return rows.map((row) => ({ ...row.score, limiterKey: row.limiterKey, runnerUpKey: row.runnerUpKey }))
}

/** The latest score under each criteria set, newest first: what the "+n" chip counts. */
export async function getBestScores(db: Db, positionId: number): Promise<ScoreRow[]> {
  const latestBySet = new Map<number, ScoreRow>()
  for (const row of await getScoreHistory(db, positionId)) {
    if (!latestBySet.has(row.criteriaSetId)) latestBySet.set(row.criteriaSetId, row)
  }
  return [...latestBySet.values()]
}
