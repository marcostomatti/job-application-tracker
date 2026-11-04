import { describe, expect, test } from 'bun:test'

import { SCALE_NAMES, ScaleSchema, scaleCriteriaSet, scaleScore, toScale } from '../../src/scoring/scale.ts'

/** Every stored value from 0 to 1 in steps of 1/10000, the grid the monotonicity check walks. */
const GRID = Array.from({ length: 10_001 }, (_, step) => step / 10_000)

describe('toScale', () => {
  test('maps the ends of 0..1 to the ends of each scale', () => {
    // Assert
    expect([toScale(0, 'stars'), toScale(1, 'stars')]).toEqual([0, 5])
    expect([toScale(0, 'percent'), toScale(1, 'percent')]).toEqual([0, 100])
    expect([toScale(0, 'basic'), toScale(1, 'basic')]).toEqual([0, 10])
  })

  test('returns a ratio exactly as stored, unrounded', () => {
    // Assert
    expect(toScale(0.123456789, 'ratio')).toBe(0.123456789)
  })

  test('rounds stars to one decimal, percent to whole numbers and basic to two decimals', () => {
    // Assert
    expect(toScale(0.7234, 'stars')).toBe(3.6)
    expect(toScale(0.7234, 'percent')).toBe(72)
    expect(toScale(0.7234, 'basic')).toBe(7.23)
  })

  test('rounds a half up, including halves that binary floating point stores just below', () => {
    // Arrange: 0.285 * 100 is 28.499999999999996 in floating point, and 0.7445 * 1000 is 744.4999999999999
    // Assert
    expect(toScale(0.285, 'percent')).toBe(29)
    expect(toScale(0.7445, 'basic')).toBe(7.45)
    expect(toScale(0.73, 'stars')).toBe(3.7)
    expect(toScale(0.71, 'stars')).toBe(3.6)
  })

  test('never shows a higher stored value below a lower one, on any scale', () => {
    for (const scale of SCALE_NAMES) {
      const shown = GRID.map((value) => toScale(value, scale))
      const inversions = shown.filter((value, index) => index > 0 && value < (shown[index - 1] ?? 0))
      expect({ scale, inversions }).toEqual({ scale, inversions: [] })
    }
  })

  test('passes null through, because an unscored bound has no value on any scale', () => {
    // Assert
    expect(toScale(null, 'stars')).toBeNull()
  })
})

describe('ScaleSchema', () => {
  test('defaults to ratio and names exactly the four scales', () => {
    // Assert
    expect(ScaleSchema.parse(undefined)).toBe('ratio')
    expect(SCALE_NAMES).toEqual(['ratio', 'stars', 'percent', 'basic'])
    expect(ScaleSchema.safeParse('grade').success).toBe(false)
  })
})

describe('scaleScore', () => {
  const stored = {
    overall: 0.72,
    floor: 0.6,
    ceiling: null,
    recommendApply: true,
    limiterCoverage: 0.4,
  }

  test('scales the overall and its bounds and leaves every other field as stored', () => {
    // Act
    const shown = scaleScore(stored, 'percent')

    // Assert
    expect(shown).toEqual({ overall: 72, floor: 60, ceiling: null, recommendApply: true, limiterCoverage: 0.4 })
  })

  test('returns a new object and leaves the stored row untouched', () => {
    // Act
    const shown = scaleScore(stored, 'stars')

    // Assert
    expect(shown).not.toBe(stored)
    expect(stored.overall).toBe(0.72)
  })

  test('keeps recommendApply as stored, even where the shown overall would read the other way', () => {
    // Arrange: stored just under a 0.60 bar, shown as 60 once rounded
    const under = { ...stored, overall: 0.5951, recommendApply: false }

    // Act
    const shown = scaleScore(under, 'percent')

    // Assert
    expect(shown).toMatchObject({ overall: 60, recommendApply: false })
  })
})

describe('scaleCriteriaSet', () => {
  test('scales the apply threshold with the same rounding as the score', () => {
    // Assert
    expect(scaleCriteriaSet({ name: 'set', applyThreshold: 0.6 }, 'stars')).toEqual({ name: 'set', applyThreshold: 3 })
    expect(scaleCriteriaSet({ name: 'set', applyThreshold: null }, 'basic')).toEqual({ name: 'set', applyThreshold: null })
  })
})
