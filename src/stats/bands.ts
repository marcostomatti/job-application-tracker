import type { LeadBand, StatsScore } from './types.ts'

/** The ask floor used when none is configured: 0.50, 2.5 stars. */
export const DEFAULT_ASK_FLOOR = 0.5

/**
 * The lead band of one posting's latest score.
 *
 * - `apply` is the stored `recommend_apply`, which already means the overall reached the set's
 *   threshold and every gate is open. It is read, never recomputed.
 * - `skip` is a gate-blocked score, or an overall below the ask floor.
 * - `ask` is the rest with an overall: from the floor to below the threshold (or above the floor
 *   when the set has no threshold, so nothing can be recommended).
 * - `unscored` is no score against this set, or a score whose overall is null because no weighted
 *   requirement was rated. It is its own group, never folded into `skip`.
 */
export function leadBand(score: StatsScore | null, askFloor: number): LeadBand {
  if (score === null) return 'unscored'
  if (score.recommendApply) return 'apply'
  if (score.gateBlocked) return 'skip'
  if (score.overall === null) return 'unscored'
  return score.overall < askFloor ? 'skip' : 'ask'
}
