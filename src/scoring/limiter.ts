import type { Detour, Rating, Requirement } from '../entities/scoring.ts'
import { effectiveCoverage } from './effective-coverage.ts'

export type LimiterResult = {
  requirementKey: string | null
  coverage: number | null
  isUnknown: boolean
  runnerUpKey: string | null
}

type Candidate = { key: string; coverage: number | null }

// Unrated sits just after a rated zero and before every positive coverage: a gate known to be
// closed is a harder fact than a gate nobody checked, but an unchecked requirement is still a
// bigger risk than one rated above zero. Ties fall back to the key for a stable order.
function compareCandidates(a: Candidate, b: Candidate): number {
  const byCoverage = (a.coverage ?? 0) - (b.coverage ?? 0)
  if (byCoverage !== 0) return byCoverage

  const byRated = Number(a.coverage === null) - Number(b.coverage === null)
  if (byRated !== 0) return byRated

  if (a.key === b.key) return 0
  return a.key < b.key ? -1 : 1
}

/**
 * The one requirement that caps a role. Layers do not enter the arithmetic: the minimum over
 * layers of the minimum within a layer equals the flat minimum, so the flat minimum is the
 * limit and layers only group the report.
 */
export function findLimiter(
  requirements: readonly Requirement[],
  ratings: readonly Rating[],
  detours: readonly Detour[],
): LimiterResult {
  const ratingByKey = new Map(ratings.map((rating) => [rating.requirementKey, rating]))

  const ranked = requirements
    .map(
      (requirement): Candidate => ({
        key: requirement.key,
        coverage: effectiveCoverage(
          ratingByKey.get(requirement.key),
          detours.filter((detour) => detour.requirementKey === requirement.key),
        ),
      }),
    )
    .sort(compareCandidates)

  const [limiter, runnerUp] = ranked
  if (limiter === undefined) {
    return { requirementKey: null, coverage: null, isUnknown: false, runnerUpKey: null }
  }

  return {
    requirementKey: limiter.key,
    coverage: limiter.coverage,
    isUnknown: limiter.coverage === null,
    runnerUpKey: runnerUp?.key ?? null,
  }
}
