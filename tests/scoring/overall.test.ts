import { describe, expect, test } from 'bun:test'
import type { Penalty, Rating, Requirement } from '../../src/entities/scoring.ts'
import { computeOverall } from '../../src/scoring/overall.ts'

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

const penalty = (amount: number): Penalty => ({ kindKey: 'penalty', amount })

describe('computeOverall', () => {
  test('normalises by the sum of the rated soft weights', () => {
    const result = computeOverall(
      [requirement('a', 0.3), requirement('b', 0.1)],
      [rating('a', 1), rating('b', 0)],
      [],
      [],
    )

    expect(result.overall).toBeCloseTo(0.75, 10)
  })

  test('ignores gate requirements in the sum', () => {
    const result = computeOverall(
      [requirement('a', 0.5), requirement('gate', 5, 'gate')],
      [rating('a', 0.8), rating('gate', 0)],
      [],
      [],
    )

    expect(result.overall).toBeCloseTo(0.8, 10)
    expect(result.floor).toBeCloseTo(0.8, 10)
    expect(result.ceiling).toBeCloseTo(0.8, 10)
  })

  test('subtracts penalties from the normalised score', () => {
    const result = computeOverall(
      [requirement('a', 0.3), requirement('b', 0.1)],
      [rating('a', 1), rating('b', 0)],
      [],
      [penalty(-0.25)],
    )

    expect(result.overall).toBeCloseTo(0.5, 10)
  })

  test('clamps the result into 0..1', () => {
    const result = computeOverall(
      [requirement('a', 1)],
      [rating('a', 0.2)],
      [],
      [penalty(-0.9)],
    )

    expect(result.overall).toBe(0)
    expect(result.floor).toBe(0)
    expect(result.ceiling).toBe(0)
  })

  test('returns null when every weight is null', () => {
    const result = computeOverall(
      [requirement('a', null), requirement('b', null)],
      [rating('a', 1), rating('b', 0.5)],
      [],
      [penalty(-0.1)],
    )

    expect(result).toEqual({ overall: null, floor: null, ceiling: null })
  })

  test('counts unrated requirements as 0 for the floor and 1 for the ceiling', () => {
    const result = computeOverall(
      [requirement('rated', 1), requirement('unrated', 1)],
      [rating('rated', 1)],
      [],
      [],
    )

    expect(result.floor).toBeCloseTo(0.5, 10)
    expect(result.ceiling).toBeCloseTo(1, 10)
  })

  test('floor equals ceiling when everything is rated', () => {
    const result = computeOverall(
      [requirement('a', 0.3), requirement('b', 0.1)],
      [rating('a', 0.6), rating('b', 0.2)],
      [],
      [penalty(-0.05)],
    )

    expect(result.floor).not.toBeNull()
    expect(result.floor).toBe(result.ceiling)
    expect(result.floor).toBe(result.overall)
  })

  test('scores an unrated requirement through a rated detour', () => {
    const result = computeOverall(
      [requirement('a', 1)],
      [],
      [{ requirementKey: 'a', label: 'detour', discount: 0.4, coverage: 1 }],
      [],
    )

    expect(result.overall).toBeCloseTo(0.6, 10)
    expect(result.floor).toBeCloseTo(0.6, 10)
    expect(result.ceiling).toBeCloseTo(0.6, 10)
  })

  test('leaves the overall null but keeps the range when nothing is rated', () => {
    const result = computeOverall([requirement('a', 1)], [], [], [])

    expect(result).toEqual({ overall: null, floor: 0, ceiling: 1 })
  })
})
