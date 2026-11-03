import { describe, expect, test } from 'bun:test'
import type { Detour, Rating } from '../../src/entities/scoring.ts'
import { effectiveCoverage } from '../../src/scoring/effective-coverage.ts'
import { DetourSchema, RatingSchema } from '../../src/schemas/scoring.ts'

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

  test('an unrated requirement becomes a number through a rated detour', () => {
    expect(effectiveCoverage(undefined, [detour(1, 0.4)])).toBeCloseTo(0.6, 10)
    expect(effectiveCoverage(rating(null), [detour(1, 0.4)])).toBeCloseTo(0.6, 10)
  })

  test('a rated detour worth nothing leaves an unrated requirement unrated', () => {
    expect(effectiveCoverage(undefined, [detour(0, 0)])).toBeNull()
    expect(effectiveCoverage(rating(null), [detour(0, 0)])).toBeNull()
  })
})

describe('scoring schema bounds', () => {
  const validRating = { requirementKey: 'req', coverage: 0.5, confidence: 'supported' }
  const validDetour = { requirementKey: 'req', label: 'detour', discount: 0.5, coverage: 0.5 }

  test('rejects a coverage above 1 and a discount below 0', () => {
    expect(RatingSchema.safeParse({ ...validRating, coverage: 1.2 }).success).toBe(false)
    expect(DetourSchema.safeParse({ ...validDetour, discount: -0.1 }).success).toBe(false)
  })

  test('accepts a null coverage as not rated', () => {
    expect(RatingSchema.safeParse({ ...validRating, coverage: null }).success).toBe(true)
    expect(DetourSchema.safeParse({ ...validDetour, coverage: null }).success).toBe(true)
  })
})
