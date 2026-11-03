import { describe, expect, test } from 'bun:test'
import { ZodError } from 'zod'
import type { Rating, Requirement, ScoreInput } from '../../src/entities/scoring.ts'
import { ScoreInputSchema } from '../../src/schemas/scoring.ts'
import { scoreAgainstSet } from '../../src/scoring/score-against-set.ts'
import { FIXTURE_POSITIONS } from '../fixtures/scoring/positions.ts'

const requirement = (
  key: string,
  weight: number | null,
  kind: 'gate' | 'soft' = 'soft',
): Requirement => ({ key, layerKey: 'layer', kind, weight, label: key })

const rating = (requirementKey: string, coverage: number | null): Rating => ({
  requirementKey,
  coverage,
  confidence: 'supported',
})

const input = (overrides: Partial<ScoreInput>): ScoreInput => ({
  requirements: [],
  ratings: [],
  detours: [],
  penalties: [],
  applyThreshold: 0.5,
  ...overrides,
})

describe('scoreAgainstSet', () => {
  test('recommends apply when the overall clears the threshold and no gate blocks', () => {
    const result = scoreAgainstSet(
      input({
        requirements: [requirement('gate', null, 'gate'), requirement('a', 1)],
        ratings: [rating('gate', 0.5), rating('a', 0.75)],
        applyThreshold: 0.75,
      }),
    )

    expect(result.overall).toBe(0.75)
    expect(result.recommendApply).toBe(true)
  })

  test('withholds apply when the overall is below the threshold', () => {
    const result = scoreAgainstSet(
      input({
        requirements: [requirement('a', 1)],
        ratings: [rating('a', 0.5)],
        applyThreshold: 0.75,
      }),
    )

    expect(result.recommendApply).toBe(false)
  })

  test('withholds apply when any gate is at effective coverage 0', () => {
    const result = scoreAgainstSet(
      input({
        requirements: [requirement('gate', null, 'gate'), requirement('a', 1)],
        ratings: [rating('gate', 0), rating('a', 1)],
        applyThreshold: 0.5,
      }),
    )

    expect(result.overall).toBe(1)
    expect(result.recommendApply).toBe(false)
  })

  // A hard gate nobody checked is not a gate that passed.
  test('withholds apply when any gate is unrated', () => {
    const result = scoreAgainstSet(
      input({
        requirements: [requirement('gate', null, 'gate'), requirement('a', 1)],
        ratings: [rating('a', 1)],
        applyThreshold: 0.5,
      }),
    )

    expect(result.overall).toBe(1)
    expect(result.limiterIsUnknown).toBe(true)
    expect(result.recommendApply).toBe(false)
  })

  test('withholds apply when the threshold is null', () => {
    const result = scoreAgainstSet(
      input({
        requirements: [requirement('a', 1)],
        ratings: [rating('a', 1)],
        applyThreshold: null,
      }),
    )

    expect(result.overall).toBe(1)
    expect(result.recommendApply).toBe(false)
  })

  test('reports the limiter alongside the recommendation', () => {
    const result = scoreAgainstSet(
      input({
        requirements: [requirement('a', 1), requirement('b', 1), requirement('c', 1)],
        ratings: [rating('a', 1), rating('b', 0.25), rating('c', 0.75)],
        applyThreshold: 0.5,
      }),
    )

    expect(result.overall).toBeCloseTo(2 / 3, 10)
    expect(result.floor).toBeCloseTo(2 / 3, 10)
    expect(result.ceiling).toBeCloseTo(2 / 3, 10)
    expect(result.limiterKey).toBe('b')
    expect(result.limiterCoverage).toBe(0.25)
    expect(result.limiterIsUnknown).toBe(false)
    expect(result.runnerUpKey).toBe('c')
    expect(result.recommendApply).toBe(true)
  })

  // The gate check reads the same detours as the score, so a detour can open a gate.
  test('allows apply when a gate rated 0 is opened by a detour', () => {
    const gate = requirement('gate', null, 'gate')
    const base = {
      requirements: [gate, requirement('a', 1)],
      ratings: [rating('gate', 0), rating('a', 1)],
      applyThreshold: 0.5,
    }
    const detour = { requirementKey: 'gate', label: 'detour', discount: 0.25, coverage: 1 }

    expect(scoreAgainstSet(input({ ...base, detours: [] })).recommendApply).toBe(false)

    // The detour gives the gate an effective coverage of 1 * (1 - 0.25) = 0.75.
    const withDetour = scoreAgainstSet(input({ ...base, detours: [detour] }))
    expect(withDetour.recommendApply).toBe(true)
  })

  test('withholds apply when a penalty drives the overall below the threshold', () => {
    const base = {
      requirements: [requirement('a', 1)],
      ratings: [rating('a', 0.75)],
      applyThreshold: 0.7,
    }

    expect(scoreAgainstSet(input(base)).recommendApply).toBe(true)

    const penalised = scoreAgainstSet(
      input({ ...base, penalties: [{ kindKey: 'penalty', amount: -0.25 }] }),
    )
    expect(penalised.overall).toBe(0.5)
    expect(penalised.recommendApply).toBe(false)
  })

  // The schemas are what make an infinite weight and a positive penalty unreachable, so the
  // boundary has to actually be crossed.
  test('rejects an infinite weight before computing', () => {
    expect(() =>
      scoreAgainstSet(
        input({
          requirements: [requirement('a', Number.POSITIVE_INFINITY)],
          ratings: [rating('a', 1)],
        }),
      ),
    ).toThrow(ZodError)
  })

  test('rejects a positive penalty before computing', () => {
    expect(() =>
      scoreAgainstSet(
        input({
          requirements: [requirement('a', 1)],
          ratings: [rating('a', 0.5)],
          penalties: [{ kindKey: 'bonus', amount: 0.5 }],
        }),
      ),
    ).toThrow(ZodError)
  })

  test.each(FIXTURE_POSITIONS)('scores fixture position $name as expected', ({
    input: positionInput,
    expected,
  }) => {
    expect(scoreAgainstSet(positionInput)).toEqual(expected)
  })
})

describe('ScoreInputSchema applyThreshold', () => {
  const withThreshold = (applyThreshold: number | null) =>
    ScoreInputSchema.safeParse(input({ applyThreshold })).success

  // 1.5 is a typo that would silently stop every recommendation, not a stricter bar.
  test.each([1.5, -0.1])('rejects a threshold of %p outside 0..1', (threshold) => {
    expect(withThreshold(threshold)).toBe(false)
  })

  // 0 recommends anything no gate blocks, 1 wants a perfect score, null is no bar set yet.
  test.each([0, 1, null])('accepts a threshold of %p', (threshold) => {
    expect(withThreshold(threshold)).toBe(true)
  })
})

describe('ScoreInputSchema weight', () => {
  const withWeight = (weight: number | null) =>
    ScoreInputSchema.safeParse(input({ requirements: [requirement('a', weight)] })).success

  // A negative weight is a typo: the score would ignore it while the limiter still ranked it.
  test('rejects a negative weight', () => {
    expect(withWeight(-0.1)).toBe(false)
  })

  // 0 records a criterion without scoring it; null means no weight has been set yet.
  test.each([0, 0.3, null])('accepts a weight of %p', (weight) => {
    expect(withWeight(weight)).toBe(true)
  })
})
