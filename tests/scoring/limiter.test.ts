import { describe, expect, test } from 'bun:test'
import type { Detour, Rating, Requirement } from '../../src/entities/scoring.ts'
import { findLimiter } from '../../src/scoring/limiter.ts'

const requirement = (key: string, layerKey = 'layer'): Requirement => ({
  key,
  layerKey,
  kind: 'soft',
  weight: 1,
  label: key,
})

const rating = (requirementKey: string, coverage: number | null): Rating => ({
  requirementKey,
  coverage,
  confidence: 'supported',
})

const detour = (requirementKey: string, coverage: number | null, discount: number): Detour => ({
  requirementKey,
  label: 'detour',
  discount,
  coverage,
})

describe('findLimiter', () => {
  test('names the requirement with the lowest effective coverage', () => {
    const result = findLimiter(
      [requirement('a'), requirement('b'), requirement('c')],
      [rating('a', 0.9), rating('b', 0.3), rating('c', 0.6)],
      [],
    )

    expect(result.requirementKey).toBe('b')
    expect(result.coverage).toBe(0.3)
    expect(result.isUnknown).toBe(false)
  })

  test('keeps the second-lowest as the runner up', () => {
    const result = findLimiter(
      [requirement('a'), requirement('b'), requirement('c')],
      [rating('a', 0.9), rating('b', 0.3), rating('c', 0.6)],
      [],
    )

    expect(result.runnerUpKey).toBe('c')
  })

  test('resolves a tie by requirement key, deterministically', () => {
    const ratings = [rating('zeta', 0.2), rating('alpha', 0.2), rating('mid', 0.8)]
    const forward = [requirement('zeta'), requirement('alpha'), requirement('mid')]
    const backward = [...forward].reverse()

    const first = findLimiter(forward, ratings, [])
    const second = findLimiter(backward, ratings, [])

    expect(first.requirementKey).toBe('alpha')
    expect(first.runnerUpKey).toBe('zeta')
    expect(second).toEqual(first)
  })

  test('flags a limiter that is only an unrated requirement', () => {
    const result = findLimiter(
      [requirement('a'), requirement('b'), requirement('unrated')],
      [rating('a', 0.9), rating('b', 0.9)],
      [],
    )

    expect(result.requirementKey).toBe('unrated')
    expect(result.coverage).toBeNull()
    expect(result.isUnknown).toBe(true)
  })

  test('prefers a rated zero over an unrated requirement as the limiter', () => {
    const result = findLimiter(
      [requirement('closed'), requirement('aaa-unrated')],
      [rating('closed', 0)],
      [],
    )

    expect(result.requirementKey).toBe('closed')
    expect(result.coverage).toBe(0)
    expect(result.isUnknown).toBe(false)
    expect(result.runnerUpKey).toBe('aaa-unrated')
  })

  test('returns nulls for an empty requirement list', () => {
    expect(findLimiter([], [], [])).toEqual({
      requirementKey: null,
      coverage: null,
      isUnknown: false,
      runnerUpKey: null,
    })
  })
})

describe('findLimiter with detours', () => {
  test('measures each requirement by its effective coverage, detours included', () => {
    const result = findLimiter(
      [requirement('a'), requirement('b')],
      [rating('a', 0.5), rating('b', 0)],
      [detour('b', 1, 0.2)],
    )

    expect(result.requirementKey).toBe('a')
    expect(result.runnerUpKey).toBe('b')
  })

  test('ignores layers: the flat minimum across layers is the limit', () => {
    const result = findLimiter(
      [requirement('a', 'one'), requirement('b', 'two')],
      [rating('a', 0.7), rating('b', 0.4)],
      [],
    )

    expect(result.requirementKey).toBe('b')
  })
})
