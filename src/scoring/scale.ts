import { z } from 'zod'

/**
 * The scales a final score can be read on (spec section 8). Every score, bound and threshold is
 * stored as a ratio from 0 to 1; a scale only changes how a read shows it. `decimals` is null for
 * the ratio, which is returned as stored.
 */
export const SCALES = {
  ratio: { max: 1, decimals: null },
  stars: { max: 5, decimals: 1 },
  percent: { max: 100, decimals: 0 },
  basic: { max: 10, decimals: 2 },
} as const

export type Scale = keyof typeof SCALES

export const SCALE_NAMES = Object.keys(SCALES) as [Scale, ...Scale[]]

/**
 * Digits kept when the scaled value is cleaned of floating-point noise before rounding, so a half
 * that binary floating point stores just below (0.285 * 100 is 28.499999999999996) still rounds up.
 * Six is far below any real difference between two stored scores and far above the noise.
 */
const NOISE_DIGITS = 6

/** The `scale` parameter every final-score read takes. */
export const ScaleSchema = z
  .enum(SCALE_NAMES)
  .default('ratio')
  .describe(
    'How to show the overall score, its floor and ceiling, and a set\'s apply threshold: ' +
      'ratio is 0..1 as stored (the default), stars is 0..5 to one decimal, percent is 0..100 in whole numbers, basic is 0..10 to two decimals. ' +
      'Coverage, penalties and recommendApply are never scaled; recommendApply is always the stored verdict.',
  )

/**
 * A stored ratio shown on `scale`, rounded half up to the scale's decimals. Every step is
 * monotone, so a value at or above another never shows below it, though two close values can
 * show as equal. A null passes through: an unscored bound has no value on any scale.
 */
export function toScale(value: number, scale: Scale): number
export function toScale(value: number | null, scale: Scale): number | null
export function toScale(value: number | null, scale: Scale): number | null {
  const { max, decimals } = SCALES[scale]
  if (value === null || decimals === null) return value
  const factor = 10 ** decimals
  const shifted = Number((value * max * factor).toFixed(NOISE_DIGITS))
  return Math.round(shifted) / factor
}

type ScoreValues = { readonly overall: number | null; readonly floor: number | null; readonly ceiling: number | null }

/** A copy of a score with its overall, floor and ceiling on `scale`; every other field as stored. */
export function scaleScore<T extends ScoreValues>(score: T, scale: Scale): T {
  if (scale === 'ratio') return score
  return {
    ...score,
    overall: toScale(score.overall, scale),
    floor: toScale(score.floor, scale),
    ceiling: toScale(score.ceiling, scale),
  }
}

/** A copy of a criteria set with its apply threshold on `scale`, rounded as a score is. */
export function scaleCriteriaSet<T extends { readonly applyThreshold: number | null }>(set: T, scale: Scale): T {
  if (scale === 'ratio') return set
  return { ...set, applyThreshold: toScale(set.applyThreshold, scale) }
}
