import { describe, expect, test } from 'bun:test'
import type { Detour, Rating } from '../../src/entities/scoring.ts'
import { effectiveCoverage } from '../../src/scoring/effective-coverage.ts'

const rating = (coverage: number | null): Rating => ({
  requirementKey: 'req',
  coverage,
  confidence: 'supported',
})

const detour = (coverage: number | null, discount: number): Detour => ({
  requirementKey: 'req',
  label: 'detour',
  discount,
  coverage,
})

describe('effectiveCoverage', () => {
  test('returns the direct coverage when there is no detour', () => {
    expect(effectiveCoverage(rating(0.4), [])).toBe(0.4)
  })

  test('returns null when the requirement is unrated and has no detour', () => {
    expect(effectiveCoverage(undefined, [])).toBeNull()
  })

  test('lifts a blocked requirement through its best detour', () => {
    expect(effectiveCoverage(rating(0), [detour(1, 0.4)])).toBeCloseTo(0.6, 10)
  })

  test('never lifts a requirement above its direct coverage when the detour is worse', () => {
    expect(effectiveCoverage(rating(0.8), [detour(1, 0.5)])).toBe(0.8)
  })

  test('picks the best of several detours', () => {
    expect(effectiveCoverage(rating(0), [detour(1, 0.7), detour(1, 0.2)])).toBeCloseTo(0.8, 10)
  })

  test('a detour with discount 1 contributes nothing', () => {
    expect(effectiveCoverage(rating(0.3), [detour(1, 1)])).toBe(0.3)
    expect(effectiveCoverage(rating(0), [detour(1, 1)])).toBe(0)
    expect(effectiveCoverage(rating(null), [detour(1, 1)])).toBeNull()
    expect(effectiveCoverage(undefined, [detour(1, 1)])).toBeNull()
  })

  test('an unrated detour does not rescue an unrated requirement', () => {
    expect(effectiveCoverage(undefined, [detour(null, 0.2)])).toBeNull()
    expect(effectiveCoverage(rating(null), [detour(null, 0.2)])).toBeNull()
  })
})
