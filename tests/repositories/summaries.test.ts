import { describe, expect, test } from 'bun:test'

import { SummaryInputSchema } from '../../src/schemas/summaries.ts'

describe('the summary input schema', () => {
  const minimal = { postingId: 1, condensed: 'Condensed', sourceHash: 'h1' }

  test('accepts a text id, as an HTTP path carries it', () => {
    // Assert
    expect(SummaryInputSchema.parse({ ...minimal, postingId: '7' }).postingId).toBe(7)
  })

  test('refuses a field it does not name, a blank hash and a blank condensed text', () => {
    // Assert
    expect(SummaryInputSchema.safeParse({ ...minimal, summarisedAt: '2026-01-01' }).success).toBe(false)
    expect(SummaryInputSchema.safeParse({ ...minimal, sourceHash: '  ' }).success).toBe(false)
    expect(SummaryInputSchema.safeParse({ ...minimal, condensed: '' }).success).toBe(false)
  })

  test('refuses a NUL character in any text field or in the extra payload', () => {
    // Assert: Postgres cannot store it, and refused here it is a validation message
    const nul = 'a\u0000b'
    expect(SummaryInputSchema.safeParse({ ...minimal, condensed: nul }).success).toBe(false)
    expect(SummaryInputSchema.safeParse({ ...minimal, description: nul }).success).toBe(false)
    expect(SummaryInputSchema.safeParse({ ...minimal, industry: nul }).success).toBe(false)
    expect(SummaryInputSchema.safeParse({ ...minimal, sourceHash: nul }).success).toBe(false)
    expect(SummaryInputSchema.safeParse({ ...minimal, stack: [nul] }).success).toBe(false)
    expect(SummaryInputSchema.safeParse({ ...minimal, extra: { nested: [{ deep: nul }] } }).success).toBe(false)
    expect(SummaryInputSchema.safeParse({ ...minimal, extra: { [nul]: 1 } }).success).toBe(false)
    expect(SummaryInputSchema.safeParse({ ...minimal, extra: { fine: 'a\\u0000b' } }).success).toBe(true)
  })

  test('refuses a stack that is not a list of tags', () => {
    // Assert
    expect(SummaryInputSchema.safeParse({ ...minimal, stack: 'typescript' }).success).toBe(false)
    expect(SummaryInputSchema.safeParse({ ...minimal, stack: [1] }).success).toBe(false)
  })
})
