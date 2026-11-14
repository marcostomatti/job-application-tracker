import { describe, expect, test } from 'bun:test'
import { PendingRescoreQuerySchema, RescoreRequestInputSchema } from '../../src/schemas/scores.ts'

const SINCE = '2026-03-10'

describe('the rescore schemas', () => {
  test('a request takes a set id and a calendar day, and refuses anything else', () => {
    expect(RescoreRequestInputSchema.parse({ criteriaSetId: '4', sinceDate: SINCE })).toEqual({ criteriaSetId: 4, sinceDate: SINCE })
    expect(RescoreRequestInputSchema.safeParse({ criteriaSetId: 4, sinceDate: '10/03/2026' }).success).toBe(false)
    expect(RescoreRequestInputSchema.safeParse({ criteriaSetId: 4, sinceDate: '2026-02-30' }).success).toBe(false)
    expect(RescoreRequestInputSchema.safeParse({ criteriaSetId: 4 }).success).toBe(false)
    expect(RescoreRequestInputSchema.safeParse({ criteriaSetId: 4, sinceDate: SINCE, extra: 1 }).success).toBe(false)
  })

  test('the pending query takes an optional request id and nothing else', () => {
    expect(PendingRescoreQuerySchema.parse({})).toEqual({})
    expect(PendingRescoreQuerySchema.parse({ rescoreRequestId: '3' })).toEqual({ rescoreRequestId: 3 })
    expect(PendingRescoreQuerySchema.safeParse({ rescoreRequestId: 0 }).success).toBe(false)
    expect(PendingRescoreQuerySchema.safeParse({ limit: 5 }).success).toBe(false)
  })
})
