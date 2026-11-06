import { describe, expect, test } from 'bun:test'

import { NO_RECOMMENDATION, recommendationOf, storedVerdictOf, verdictColumnsOf } from '../../src/stats/recommendation.ts'

const ASK_FLOOR = 0.5

const scored = (overall: number | null, recommendApply = false) => ({ overall, recommendApply })

describe('recommendationOf: the rules band', () => {
  test.each([
    ['the stored recommendApply', scored(0.8, true), false, 'apply'],
    ['a gate-blocked score, even above the threshold', scored(0.9), true, 'skip'],
    ['an overall from the floor up', scored(0.5), false, 'ask'],
    ['an overall just below the floor', scored(0.4999), false, 'skip'],
    ['a score with no overall', scored(null), false, 'unscored'],
  ] as const)('%s gives %s', (_label, score, gateBlocked, band) => {
    // Act
    const recommendation = recommendationOf(score, gateBlocked, ASK_FLOOR, null)

    // Assert
    expect(recommendation.rules).toBe(band)
  })

  test('a gate-blocked score is skip, which the old client-side reading (gates always open) showed as ask', () => {
    const blocked = recommendationOf(scored(0.6), true, ASK_FLOOR, null)
    const open = recommendationOf(scored(0.6), false, ASK_FLOOR, null)

    expect(blocked.rules).toBe('skip')
    expect(open.rules).toBe('ask')
  })

  test('the ask floor is the configured one, not a constant', () => {
    expect(recommendationOf(scored(0.6), false, 0.7, null).rules).toBe('skip')
    expect(recommendationOf(scored(0.6), false, 0.6, null).rules).toBe('ask')
  })

  test('no score is unscored, with no agent verdict and no disagreement', () => {
    expect(recommendationOf(null, false, ASK_FLOOR, null)).toEqual(NO_RECOMMENDATION)
    expect(NO_RECOMMENDATION).toEqual({ rules: 'unscored', agent: null, disagree: false })
  })
})

describe('recommendationOf: the agent verdict and the disagreement', () => {
  test('carries the verdict as given', () => {
    const verdict = { band: 'apply', reason: 'The sheet says apply.' } as const

    const recommendation = recommendationOf(scored(0.8, true), false, ASK_FLOOR, verdict)

    expect(recommendation.agent).toEqual(verdict)
    expect(recommendation.disagree).toBe(false)
  })

  test('disagrees when both exist and differ', () => {
    const recommendation = recommendationOf(scored(0.6), true, ASK_FLOOR, { band: 'apply', reason: null })

    expect(recommendation).toEqual({ rules: 'skip', agent: { band: 'apply', reason: null }, disagree: true })
  })

  test('does not disagree when the rules have no band to compare, because the score has no overall', () => {
    const recommendation = recommendationOf(scored(null), false, ASK_FLOOR, { band: 'skip', reason: null })

    expect(recommendation.rules).toBe('unscored')
    expect(recommendation.disagree).toBe(false)
  })

  test('does not disagree with no verdict', () => {
    expect(recommendationOf(scored(0.2), false, ASK_FLOOR, null).disagree).toBe(false)
  })
})

describe('storedVerdictOf', () => {
  test('reads a stored band and reason as a verdict', () => {
    expect(storedVerdictOf('ask', 'Salary unknown.')).toEqual({ band: 'ask', reason: 'Salary unknown.' })
    expect(storedVerdictOf('skip', null)).toEqual({ band: 'skip', reason: null })
  })

  test('no stored band is no verdict, whatever the reason column holds', () => {
    expect(storedVerdictOf(null, null)).toBeNull()
    expect(storedVerdictOf(null, 'orphan reason')).toBeNull()
  })

  test('a band the CHECK should have refused is a broken invariant, not a silent null', () => {
    expect(() => storedVerdictOf('maybe', null)).toThrow()
  })
})

describe('verdictColumnsOf', () => {
  test('maps a verdict to its two columns, and none to two nulls', () => {
    expect(verdictColumnsOf({ band: 'apply', reason: 'why' })).toEqual({ agentVerdict: 'apply', agentReason: 'why' })
    expect(verdictColumnsOf(null)).toEqual({ agentVerdict: null, agentReason: null })
    expect(verdictColumnsOf(undefined)).toEqual({ agentVerdict: null, agentReason: null })
  })
})
