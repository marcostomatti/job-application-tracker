import { describe, expect, test } from 'bun:test'

import { AGENT_REASON_MAX, AppSettingsPatchSchema } from '../../src/schemas/recommendation.ts'
import { ScorePostingBulkSchema, ScorePostingCallSchema, ScoreVerdictSetInputSchema } from '../../src/schemas/scores.ts'

const SCORE_CALL = { postingId: 1, criteriaSetId: 2, ratings: [], penalties: [], scale: 'ratio' } as const

describe('score_posting takes an optional verdict', () => {
  test('a call without a verdict still parses, and carries none', () => {
    const parsed = ScorePostingCallSchema.parse(SCORE_CALL)

    expect(parsed.verdict).toBeUndefined()
  })

  test('a verdict with no reason reads the reason as null', () => {
    const parsed = ScorePostingCallSchema.parse({ ...SCORE_CALL, verdict: { band: 'skip' } })

    expect(parsed.verdict).toEqual({ band: 'skip', reason: null })
  })

  test('a verdict keeps its trimmed reason', () => {
    const parsed = ScorePostingCallSchema.parse({ ...SCORE_CALL, verdict: { band: 'apply', reason: '  Sheet says Apply. ' } })

    expect(parsed.verdict).toEqual({ band: 'apply', reason: 'Sheet says Apply.' })
  })

  test.each([
    ['unscored, which is a rules band only', { band: 'unscored' }],
    ['a band outside the verdicts', { band: 'maybe' }],
    ['a reason over the limit', { band: 'ask', reason: 'x'.repeat(AGENT_REASON_MAX + 1) }],
    ['a blank reason', { band: 'ask', reason: '   ' }],
    ['a reason with a NUL, which the text column cannot store', { band: 'ask', reason: 'a\u0000b' }],
    ['an unknown key', { band: 'ask', why: 'because' }],
  ])('refuses %s', (_label, verdict) => {
    expect(ScorePostingCallSchema.safeParse({ ...SCORE_CALL, verdict }).success).toBe(false)
  })

  test('a reason exactly at the limit is accepted', () => {
    const parsed = ScorePostingCallSchema.safeParse({ ...SCORE_CALL, verdict: { band: 'ask', reason: 'x'.repeat(AGENT_REASON_MAX) } })

    expect(parsed.success).toBe(true)
  })

  test('each bulk item may carry its own verdict', () => {
    const { scale: _scale, ...item } = SCORE_CALL
    const parsed = ScorePostingBulkSchema.parse({
      scale: 'ratio',
      items: [{ ...item, verdict: { band: 'apply' } }, { ...item, postingId: 3 }],
    })

    expect(parsed.items.map((entry) => entry.verdict)).toEqual([{ band: 'apply', reason: null }, undefined])
  })
})

describe('score_verdict_set', () => {
  test('takes a verdict, with the set optional', () => {
    const parsed = ScoreVerdictSetInputSchema.parse({ postingId: 1, verdict: { band: 'ask', reason: 'Remote unclear.' } })

    expect(parsed).toEqual({ postingId: 1, verdict: { band: 'ask', reason: 'Remote unclear.' } })
  })

  test('takes null to clear the verdict', () => {
    expect(ScoreVerdictSetInputSchema.parse({ postingId: 1, criteriaSetId: 4, verdict: null }).verdict).toBeNull()
  })

  test('refuses a call that leaves the verdict out, so clearing is always said out loud', () => {
    expect(ScoreVerdictSetInputSchema.safeParse({ postingId: 1 }).success).toBe(false)
  })
})

describe('settings_update', () => {
  test('takes either setting alone', () => {
    expect(AppSettingsPatchSchema.parse({ askFloor: 0.6 })).toEqual({ askFloor: 0.6 })
    expect(AppSettingsPatchSchema.parse({ recommendationDisplay: 'agent' })).toEqual({ recommendationDisplay: 'agent' })
  })

  test.each([
    ['an empty patch', {}],
    ['an ask floor above 1', { askFloor: 1.2 }],
    ['an unknown display', { recommendationDisplay: 'neither' }],
    ['an unknown key', { theme: 'dark' }],
  ])('refuses %s', (_label, patch) => {
    expect(AppSettingsPatchSchema.safeParse(patch).success).toBe(false)
  })
})
