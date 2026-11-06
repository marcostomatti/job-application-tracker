import { and, eq, inArray, type InferSelectModel } from 'drizzle-orm'

import type { Recommendation } from '../../schemas/recommendation.ts'
import { effectiveCoverage } from '../../scoring/effective-coverage.ts'
import { NO_RECOMMENDATION, recommendationOf, storedVerdictOf } from '../../stats/recommendation.ts'
import { detour, requirement } from '../schema/criteria.ts'
import { postingRating, postingRatingDetour, type postingScore } from '../schema/scores.ts'
import type { Db } from './db.ts'
import { readAskFloor } from './stats.ts'

type Score = InferSelectModel<typeof postingScore>

/** The requirement kind that blocks a score; the members are REQUIREMENT_KINDS. */
const GATE_KIND = 'gate'

/**
 * The scores among `scoreIds` with a gate measured and not met: a gate rating whose effective
 * coverage (detours included) is 0. This is the rule `readStatsSource` applies, so the board and
 * the stats page agree. An unrated gate has no rating row and is not measured, so not blocked; a
 * detour coverage hangs off a rating, so a gate with no rating has no detour row either.
 * Two queries for any number of scores, never one per score.
 */
export async function gateBlockedScoreIds(db: Db, scoreIds: readonly number[]): Promise<ReadonlySet<number>> {
  if (scoreIds.length === 0) return new Set()
  const ids = [...scoreIds]
  const [ratings, detours] = await Promise.all([
    db
      .select({ scoreId: postingRating.scoreId, requirementId: postingRating.requirementId, coverage: postingRating.coverage, key: requirement.key })
      .from(postingRating)
      .innerJoin(requirement, eq(requirement.id, postingRating.requirementId))
      .where(and(inArray(postingRating.scoreId, ids), eq(requirement.kind, GATE_KIND))),
    db
      .select({
        scoreId: postingRatingDetour.scoreId,
        requirementId: postingRatingDetour.requirementId,
        coverage: postingRatingDetour.coverage,
        discount: detour.discount,
        label: detour.label,
      })
      .from(postingRatingDetour)
      .innerJoin(detour, eq(detour.id, postingRatingDetour.detourId))
      .innerJoin(requirement, eq(requirement.id, postingRatingDetour.requirementId))
      .where(and(inArray(postingRatingDetour.scoreId, ids), eq(requirement.kind, GATE_KIND))),
  ])
  const pair = (scoreId: number, requirementId: number): string => `${scoreId}:${requirementId}`
  const detoursAt = new Map<string, (typeof detours)[number][]>()
  for (const entry of detours) {
    const at = pair(entry.scoreId, entry.requirementId)
    detoursAt.set(at, [...(detoursAt.get(at) ?? []), entry])
  }
  const blocked = ratings.filter((rating) => {
    const routes = (detoursAt.get(pair(rating.scoreId, rating.requirementId)) ?? []).map((entry) => ({ requirementKey: rating.key, ...entry }))
    const coverage = effectiveCoverage({ requirementKey: rating.key, coverage: rating.coverage, confidence: 'unknown' }, routes)
    return coverage !== null && coverage <= 0
  })
  return new Set(blocked.map((rating) => rating.scoreId))
}

/**
 * Both recommendations of each score, keyed by score id: the rules band with the real gate
 * state and the configured ask floor, and the agent verdict stored on the score. A fixed number
 * of queries (the ask floor and the gate ratings) whatever the number of scores.
 */
export async function recommendationsOf(db: Db, scores: readonly Score[]): Promise<ReadonlyMap<number, Recommendation>> {
  if (scores.length === 0) return new Map()
  const [askFloor, blocked] = await Promise.all([readAskFloor(db), gateBlockedScoreIds(db, scores.map((score) => score.id))])
  return new Map(
    scores.map((score) => [
      score.id,
      recommendationOf(score, blocked.has(score.id), askFloor, storedVerdictOf(score.agentVerdict, score.agentReason)),
    ]),
  )
}

/** The recommendation of one score from a map `recommendationsOf` built; no score is unscored. */
export function recommendationIn(map: ReadonlyMap<number, Recommendation>, score: Score | null): Recommendation {
  return score === null ? NO_RECOMMENDATION : (map.get(score.id) ?? NO_RECOMMENDATION)
}
