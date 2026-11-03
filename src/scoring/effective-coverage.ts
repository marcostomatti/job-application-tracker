import type { Detour, Rating } from '../entities/scoring.ts'

/**
 * Coverage of a requirement once its detours are taken into account.
 *
 * A detour contributes its own coverage times (1 - discount). The result is the larger of
 * that and the direct coverage. A null direct coverage means "not rated", and stays null
 * unless a rated detour contributes something above zero; null is never treated as 0.
 */
export function effectiveCoverage(
  rating: Rating | undefined,
  detours: readonly Detour[],
): number | null {
  const direct = rating?.coverage ?? null

  let bestDetour = 0
  for (const detour of detours) {
    if (detour.coverage === null) continue
    bestDetour = Math.max(bestDetour, detour.coverage * (1 - detour.discount))
  }

  if (direct === null) return bestDetour > 0 ? bestDetour : null
  return Math.max(direct, bestDetour)
}
