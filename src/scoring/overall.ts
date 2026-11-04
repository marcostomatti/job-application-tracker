import type { Detour, Penalty, Rating, Requirement } from '../entities/scoring.ts'
import { effectiveCoverage } from './effective-coverage.ts'

export type OverallResult = {
  overall: number | null
  floor: number | null
  ceiling: number | null
}

type WeightedCoverage = { weight: number; coverage: number | null }

const clampToUnit = (value: number): number => Math.min(1, Math.max(0, value))

/**
 * One comparable number per criteria set.
 *
 * Only soft requirements with a positive weight take part; gates are pass-or-block and
 * contribute no points. Dividing by the weight total puts every set on the same 0..1 scale,
 * so the same apply threshold means the same thing in each. `overall` is the average over the
 * rated requirements; `floor` counts every unrated one as 0 and `ceiling` as 1, so a wide gap
 * between them says the posting needs questions asked. Penalties are signed amounts added to
 * all three, and each result is clamped into 0..1. When no weight exists to normalise against
 * (a fresh pack before the seed interview), all three are null.
 */
export function computeOverall(
  requirements: readonly Requirement[],
  ratings: readonly Rating[],
  detours: readonly Detour[],
  penalties: readonly Penalty[],
): OverallResult {
  const ratingByKey = new Map(ratings.map((rating) => [rating.requirementKey, rating]))

  const entries: WeightedCoverage[] = []
  for (const requirement of requirements) {
    if (requirement.kind !== 'soft') continue
    if (requirement.weight === null || !(requirement.weight > 0)) continue
    entries.push({
      weight: requirement.weight,
      coverage: effectiveCoverage(
        ratingByKey.get(requirement.key),
        detours.filter((detour) => detour.requirementKey === requirement.key),
      ),
    })
  }

  const totalWeight = entries.reduce((sum, entry) => sum + entry.weight, 0)
  if (totalWeight <= 0) return { overall: null, floor: null, ceiling: null }

  const penaltyTotal = penalties.reduce((sum, penalty) => sum + penalty.amount, 0)
  const score = (points: number, weight: number): number =>
    clampToUnit(points / weight + penaltyTotal)

  let ratedPoints = 0
  let ratedWeight = 0
  let floorPoints = 0
  let ceilingPoints = 0
  for (const { weight, coverage } of entries) {
    if (coverage === null) {
      ceilingPoints += weight
      continue
    }
    ratedPoints += weight * coverage
    ratedWeight += weight
    floorPoints += weight * coverage
    ceilingPoints += weight * coverage
  }

  return {
    overall: ratedWeight > 0 ? score(ratedPoints, ratedWeight) : null,
    floor: score(floorPoints, totalWeight),
    ceiling: score(ceilingPoints, totalWeight),
  }
}
