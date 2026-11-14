import { describe, expect, test } from 'bun:test'

import { OriginInputSchema, SearchRunHitsQuerySchema } from '../../src/schemas/provenance.ts'

const RUN_TOUCH = { touchedOn: '2026-01-05', searchRunId: 3 }

describe('OriginInputSchema, the search hit fields', () => {
  test('a touch from a search run takes its rank, whether it was new, and the title triage', () => {
    const hit = { ...RUN_TOUCH, rank: 1, wasNew: false, titleTriage: 'skip_title' as const }

    expect(OriginInputSchema.parse(hit)).toEqual(hit)
    expect(OriginInputSchema.parse({ ...RUN_TOUCH, titleTriage: 'score' }).titleTriage).toBe('score')
  })

  test('each field may be left out or null, because a run does not always know it', () => {
    expect(OriginInputSchema.safeParse(RUN_TOUCH).success).toBe(true)
    expect(OriginInputSchema.safeParse({ ...RUN_TOUCH, rank: null, wasNew: null, titleTriage: null }).success).toBe(true)
  })

  test('a touch with no search run refuses all three, since only a search has a rank', () => {
    for (const field of [{ rank: 1 }, { wasNew: true }, { titleTriage: 'score' }]) {
      const refused = OriginInputSchema.safeParse({ touchedOn: '2026-01-05', ...field })
      expect(refused.success).toBe(false)
      expect(refused.error?.issues[0]?.message).toMatch(/searchRunId/)
    }
  })

  test('a null search run refuses them too', () => {
    expect(OriginInputSchema.safeParse({ touchedOn: '2026-01-05', searchRunId: null, rank: 1 }).success).toBe(false)
  })

  test('the rank is a whole number from 1, and the triage is one of the two known values', () => {
    for (const rank of [0, -1, 1.5, '1']) {
      expect(OriginInputSchema.safeParse({ ...RUN_TOUCH, rank }).success).toBe(false)
    }
    expect(OriginInputSchema.safeParse({ ...RUN_TOUCH, titleTriage: 'maybe' }).success).toBe(false)
    expect(OriginInputSchema.safeParse({ ...RUN_TOUCH, wasNew: 'yes' }).success).toBe(false)
  })
})

describe('SearchRunHitsQuerySchema', () => {
  test('names one search run by its id, and nothing else', () => {
    expect(SearchRunHitsQuerySchema.parse({ searchRunId: 3 })).toEqual({ searchRunId: 3 })
    expect(SearchRunHitsQuerySchema.safeParse({}).success).toBe(false)
    expect(SearchRunHitsQuerySchema.safeParse({ searchRunId: 0 }).success).toBe(false)
    expect(SearchRunHitsQuerySchema.safeParse({ searchRunId: 3, postingId: 1 }).success).toBe(false)
  })
})
