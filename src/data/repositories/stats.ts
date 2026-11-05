import { asc, desc, eq, inArray, isNull } from 'drizzle-orm'

import { NotFoundError } from '../../errors.ts'
import { effectiveCoverage } from '../../scoring/effective-coverage.ts'
import { DEFAULT_ASK_FLOOR } from '../../stats/bands.ts'
import type { StatsContext, StatsPosting, StatsRequirement, StatsScore } from '../../stats/types.ts'
import { appConfig } from '../schema/config.ts'
import { criteriaSet, detour, requirement } from '../schema/criteria.ts'
import { postingStageEvent } from '../schema/dispositions.ts'
import { posting, postingSummary } from '../schema/postings.ts'
import { postingFirstTouch } from '../schema/provenance.ts'
import { phase, route, seniority, stage } from '../schema/registries.ts'
import { postingRating, postingRatingDetour, postingScore } from '../schema/scores.ts'
import type { Db } from './db.ts'

/** The `app_config` key holding the ratio the `ask` lead band starts at. */
export const ASK_FLOOR_KEY = 'stats_ask_floor'

/** The summary `extra` field the stats read years of experience from. Only a finite number from 0 to 60 counts. */
export const YEARS_EXPERIENCE_FIELD = 'years_experience'
const MAX_YEARS = 60

/** The configured ask floor, or 0.50 when none is stored or the stored value is not a ratio. */
export async function readAskFloor(db: Db): Promise<number> {
  const [row] = await db.select({ value: appConfig.value }).from(appConfig).where(eq(appConfig.key, ASK_FLOOR_KEY))
  const value = row?.value
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : DEFAULT_ASK_FLOOR
}

export async function writeAskFloor(db: Db, askFloor: number): Promise<number> {
  await db
    .insert(appConfig)
    .values({ key: ASK_FLOOR_KEY, value: askFloor })
    .onConflictDoUpdate({ target: appConfig.key, set: { value: askFloor } })
  return askFloor
}

/** The set the stats are read for: the one asked for, else the default, else the newest active set. */
async function resolveSet(db: Db, criteriaSetId: number | undefined): Promise<typeof criteriaSet.$inferSelect> {
  if (criteriaSetId !== undefined) {
    const [found] = await db.select().from(criteriaSet).where(eq(criteriaSet.id, criteriaSetId))
    if (!found) throw new NotFoundError('criteria set', criteriaSetId)
    return found
  }
  const [chosen] = await db
    .select()
    .from(criteriaSet)
    .where(isNull(criteriaSet.archivedAt))
    .orderBy(desc(criteriaSet.isDefault), desc(criteriaSet.createdAt), desc(criteriaSet.id))
    .limit(1)
  if (!chosen) throw new NotFoundError('criteria set', 'default (there is none yet)')
  return chosen
}

export interface StatsSource {
  readonly context: Omit<StatsContext, 'scale' | 'askFloor'>
  readonly gateIds: readonly number[]
  readonly postings: readonly StatsPosting[]
}

function yearsFrom(extra: unknown): number | null {
  if (typeof extra !== 'object' || extra === null) return null
  const value = (extra as Record<string, unknown>)[YEARS_EXPERIENCE_FIELD]
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_YEARS ? value : null
}

function stackFrom(stack: unknown): string[] {
  return Array.isArray(stack) ? stack.filter((tag): tag is string => typeof tag === 'string') : []
}

/** The first row of each posting in rows already ordered newest first within a posting. */
function firstPerPosting<T extends { postingId: number | null }>(rows: readonly T[]): T[] {
  const seen = new Set<number | null>()
  return rows.filter((row) => (seen.has(row.postingId) ? false : (seen.add(row.postingId), true)))
}

/** Each posting's latest score against the set, by day then id. */
async function latestScores(db: Db, setId: number) {
  const rows = await db
    .select({
      id: postingScore.id,
      postingId: postingScore.postingId,
      overall: postingScore.overall,
      recommendApply: postingScore.recommendApply,
    })
    .from(postingScore)
    .where(eq(postingScore.criteriaSetId, setId))
    .orderBy(postingScore.postingId, desc(postingScore.scoredAt), desc(postingScore.id))
  return firstPerPosting(rows)
}

/** Every rating and detour coverage of the given scores, as effective coverage per score and requirement. */
async function coveragesOf(db: Db, scoreIds: readonly number[], requirements: readonly { id: number; key: string }[]) {
  if (scoreIds.length === 0) return new Map<number, Map<number, number | null>>()
  const ratings = await db
    .select({ scoreId: postingRating.scoreId, requirementId: postingRating.requirementId, coverage: postingRating.coverage })
    .from(postingRating)
    .where(inArray(postingRating.scoreId, [...scoreIds]))
  const detours = await db
    .select({
      scoreId: postingRatingDetour.scoreId,
      requirementId: postingRatingDetour.requirementId,
      coverage: postingRatingDetour.coverage,
      discount: detour.discount,
      label: detour.label,
    })
    .from(postingRatingDetour)
    .innerJoin(detour, eq(detour.id, postingRatingDetour.detourId))
    .where(inArray(postingRatingDetour.scoreId, [...scoreIds]))

  const pair = (scoreId: number, requirementId: number): string => `${scoreId}:${requirementId}`
  const ratingAt = new Map(ratings.map((entry) => [pair(entry.scoreId, entry.requirementId), entry.coverage]))
  const detoursAt = new Map<string, { discount: number; label: string; coverage: number | null }[]>()
  for (const entry of detours) {
    const at = pair(entry.scoreId, entry.requirementId)
    detoursAt.set(at, [...(detoursAt.get(at) ?? []), entry])
  }

  const result = new Map<number, Map<number, number | null>>()
  for (const scoreId of scoreIds) {
    const byRequirement = new Map<number, number | null>()
    for (const { id, key } of requirements) {
      const at = pair(scoreId, id)
      const rating = ratingAt.has(at) ? { requirementKey: key, coverage: ratingAt.get(at) ?? null, confidence: 'unknown' as const } : undefined
      const routes = (detoursAt.get(at) ?? []).map((entry) => ({ requirementKey: key, ...entry }))
      byRequirement.set(id, effectiveCoverage(rating, routes))
    }
    result.set(scoreId, byRequirement)
  }
  return result
}

/**
 * Reads what the stats aggregate, for one criteria set: every posting, its first-touch route,
 * its current stage, its seniority and stored summary, and its latest score against that set
 * alone, with each requirement's effective coverage. Scores against other sets are not read, so
 * two rubrics never meet in one series. Reads only; writes nothing.
 */
export async function readStatsSource(db: Db, criteriaSetId?: number): Promise<StatsSource> {
  const set = await resolveSet(db, criteriaSetId)
  const requirements = await db
    .select({ id: requirement.id, key: requirement.key, label: requirement.label, kind: requirement.kind })
    .from(requirement)
    .where(eq(requirement.criteriaSetId, set.id))
    .orderBy(asc(requirement.sort), asc(requirement.id))
  const soft: StatsRequirement[] = requirements.filter((entry) => entry.kind === 'soft').map(({ id, key, label }) => ({ id, key, label }))
  const gateIds = requirements.filter((entry) => entry.kind === 'gate').map((entry) => entry.id)

  const rows = await db
    .select({
      id: posting.id,
      seenAt: posting.seenAt,
      seniorityLabel: seniority.label,
      senioritySort: seniority.sort,
      industry: postingSummary.industry,
      stack: postingSummary.stack,
      extra: postingSummary.extra,
      condensed: postingSummary.condensed,
      hasSummary: postingSummary.postingId,
    })
    .from(posting)
    .leftJoin(seniority, eq(seniority.id, posting.seniorityId))
    .leftJoin(postingSummary, eq(postingSummary.postingId, posting.id))
    .orderBy(asc(posting.id))

  const sources = new Map(
    (
      await db
        .select({ postingId: postingFirstTouch.postingId, label: route.label })
        .from(postingFirstTouch)
        .innerJoin(route, eq(route.id, postingFirstTouch.routeId))
    ).map((row) => [row.postingId, row.label]),
  )

  // The latest event by time, then id, as `currentStage` reads it.
  const events = await db
    .select({
      postingId: postingStageEvent.postingId,
      label: stage.label,
      sort: stage.sort,
      phase: phase.label,
      phaseSort: phase.sort,
    })
    .from(postingStageEvent)
    .leftJoin(stage, eq(stage.id, postingStageEvent.stageId))
    .leftJoin(phase, eq(phase.id, stage.phaseId))
    .orderBy(postingStageEvent.postingId, desc(postingStageEvent.occurredAt), desc(postingStageEvent.id))
  const latestEvents = firstPerPosting(events)
  const stages = new Map(latestEvents.map((row) => [row.postingId, row]))

  const scores = await latestScores(db, set.id)
  const coverages = await coveragesOf(db, scores.map((entry) => entry.id), requirements)
  const scoreOf = new Map<number, StatsScore>(
    scores.map((entry) => {
      const byRequirement = coverages.get(entry.id) ?? new Map<number, number | null>()
      // Blocked means a gate was measured and not met. An unrated gate is not measured: it keeps
      // the posting out of `apply` (recommend_apply is false) but does not push it into `skip`.
      const gateBlocked = gateIds.some((id) => {
        const coverage = byRequirement.get(id) ?? null
        return coverage !== null && coverage <= 0
      })
      return [
        entry.postingId,
        {
          overall: entry.overall,
          recommendApply: entry.recommendApply,
          gateBlocked,
          softCoverages: soft.map(({ id }) => ({ requirementId: id, coverage: byRequirement.get(id) ?? null })),
        },
      ]
    }),
  )

  const postings: StatsPosting[] = rows.map((row) => {
    const event = stages.get(row.id)
    return {
      id: row.id,
      seenAt: row.seenAt,
      source: sources.get(row.id) ?? null,
      stage: event?.label == null ? null : { label: event.label, sort: event.sort ?? 0, phase: event.phase ?? null, phaseSort: event.phaseSort ?? Number.MAX_SAFE_INTEGER },
      seniority: row.seniorityLabel === null ? null : { label: row.seniorityLabel, sort: row.senioritySort ?? 0 },
      summary:
        row.hasSummary === null
          ? null
          : { industry: row.industry ?? null, stack: stackFrom(row.stack), yearsExperience: yearsFrom(row.extra), condensed: row.condensed ?? '' },
      score: scoreOf.get(row.id) ?? null,
    }
  })

  return {
    context: { criteriaSet: { id: set.id, name: set.name, version: set.version, applyThreshold: set.applyThreshold }, softRequirements: soft },
    gateIds,
    postings,
  }
}

