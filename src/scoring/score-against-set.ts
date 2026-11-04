import type { ScoreInput } from '../entities/scoring.ts'
import { ScoreInputSchema } from '../schemas/scoring.ts'
import { effectiveCoverage } from './effective-coverage.ts'
import { findLimiter } from './limiter.ts'
import { computeOverall } from './overall.ts'

export type ScoreResult = {
  overall: number | null
  floor: number | null
  ceiling: number | null
  limiterKey: string | null
  limiterCoverage: number | null
  limiterIsUnknown: boolean
  runnerUpKey: string | null
  recommendApply: boolean
}

/**
 * Answers both questions about a role from one set of rating rows: how good is it (a number
 * to compare with the apply threshold) and what stops it (the named limiting requirement).
 *
 * The input is parsed first. The schemas are what keep an infinite weight (which would turn
 * every score into NaN) and a positive penalty (which would raise the score) out of the
 * arithmetic, so the functions below only ever see parsed data.
 *
 * Apply is recommended only when the overall is known and reaches a known threshold, and every
 * gate has been rated and is covered above 0. A gate nobody has rated has not passed.
 */
export function scoreAgainstSet(rawInput: ScoreInput): ScoreResult {
  const { requirements, ratings, detours, penalties, applyThreshold } =
    ScoreInputSchema.parse(rawInput)

  const { overall, floor, ceiling } = computeOverall(requirements, ratings, detours, penalties)
  const limiter = findLimiter(requirements, ratings, detours)

  const ratingByKey = new Map(ratings.map((rating) => [rating.requirementKey, rating]))
  const everyGateIsOpen = requirements
    .filter((requirement) => requirement.kind === 'gate')
    .every((gate) => {
      const coverage = effectiveCoverage(
        ratingByKey.get(gate.key),
        detours.filter((detour) => detour.requirementKey === gate.key),
      )
      return coverage !== null && coverage > 0
    })

  const clearsThreshold = overall !== null && applyThreshold !== null && overall >= applyThreshold

  return {
    overall,
    floor,
    ceiling,
    limiterKey: limiter.requirementKey,
    limiterCoverage: limiter.coverage,
    limiterIsUnknown: limiter.isUnknown,
    runnerUpKey: limiter.runnerUpKey,
    recommendApply: clearsThreshold && everyGateIsOpen,
  }
}
