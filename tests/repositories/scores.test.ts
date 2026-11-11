import { describe, expect, test } from 'bun:test'

import { isForeignKeyViolation } from '../../src/data/driver-faults.ts'
import { BULK_MAX } from '../../src/schemas/common.ts'
import {
  PenaltyInputSchema,
  RatingInputSchema,
  ScorePostingBulkSchema,
  ScorePostingInputSchema,
} from '../../src/schemas/scores.ts'

describe('isForeignKeyViolation', () => {
  const fault = { code: '23503', constraint_name: 'some_fk' }

  test('matches the bare driver error and the one Drizzle wraps as its cause', () => {
    expect(isForeignKeyViolation(fault, 'some_fk')).toBe(true)
    expect(isForeignKeyViolation(new Error('Failed query', { cause: fault }), 'some_fk')).toBe(true)
  })

  test('does not match another constraint, another SQLSTATE, or something that is not a fault', () => {
    expect(isForeignKeyViolation(fault, 'other_fk')).toBe(false)
    expect(isForeignKeyViolation({ ...fault, code: '23505' }, 'some_fk')).toBe(false)
    expect(isForeignKeyViolation(new Error('plain'), 'some_fk')).toBe(false)
    expect(isForeignKeyViolation(null, 'some_fk')).toBe(false)
    expect(isForeignKeyViolation(undefined, 'some_fk')).toBe(false)
  })
})

describe('the score schemas', () => {
  const rating = { requirementId: 1, coverage: 0.5, confidence: 'partial' as const }

  test('a rating takes a coverage from 0 to 1 or null, and refuses NaN, a value past 1 and an unknown key', () => {
    expect(RatingInputSchema.parse({ ...rating, coverage: null })).toMatchObject({ coverage: null })
    expect(RatingInputSchema.parse({ ...rating, coverage: 0 })).toMatchObject({ coverage: 0 })
    expect(RatingInputSchema.safeParse({ ...rating, coverage: 1.5 }).success).toBe(false)
    expect(RatingInputSchema.safeParse({ ...rating, coverage: Number.NaN }).success).toBe(false)
    expect(RatingInputSchema.safeParse({ ...rating, extra: 1 }).success).toBe(false)
    expect(RatingInputSchema.safeParse({ requirementId: 1, confidence: 'partial' }).success).toBe(false)
  })

  test('a rating defaults its confidence to unknown and refuses one that is not a confidence', () => {
    expect(RatingInputSchema.parse({ requirementId: '2', coverage: null })).toMatchObject({ requirementId: 2, confidence: 'unknown' })
    expect(RatingInputSchema.safeParse({ ...rating, confidence: 'sure' }).success).toBe(false)
  })

  test('evidence, a note and a penalty reason refuse NUL', () => {
    expect(RatingInputSchema.safeParse({ ...rating, evidence: 'a\u0000b' }).success).toBe(false)
    expect(PenaltyInputSchema.safeParse({ penaltyKindId: 1, amount: -0.1, reason: 'a\u0000' }).success).toBe(false)
    expect(ScorePostingInputSchema.safeParse({ postingId: 1, criteriaSetId: 1, ratings: [], penalties: [], note: 'x\u0000' }).success).toBe(false)
  })

  test('a penalty is a finite amount that is never positive', () => {
    expect(PenaltyInputSchema.parse({ penaltyKindId: 1, amount: -0.25 })).toMatchObject({ amount: -0.25 })
    expect(PenaltyInputSchema.parse({ penaltyKindId: 1, amount: 0 })).toMatchObject({ amount: 0 })
    expect(PenaltyInputSchema.safeParse({ penaltyKindId: 1, amount: 0.1 }).success).toBe(false)
    expect(PenaltyInputSchema.safeParse({ penaltyKindId: 1, amount: Number.NEGATIVE_INFINITY }).success).toBe(false)
    expect(PenaltyInputSchema.safeParse({ penaltyKindId: 1, amount: Number.NaN }).success).toBe(false)
  })

  test('a rating may carry detour coverages, each from 0 to 1 or null, and refuses a detour named twice', () => {
    const withDetours = (detours: unknown[]): unknown => ({ postingId: 1, criteriaSetId: 1, penalties: [], ratings: [{ ...rating, detours }] })
    expect(ScorePostingInputSchema.safeParse(withDetours([{ detourId: 2, coverage: 0.5 }, { detourId: 3, coverage: null }])).success).toBe(true)
    expect(ScorePostingInputSchema.safeParse(withDetours([{ detourId: 2, coverage: 1.5 }])).success).toBe(false)
    expect(ScorePostingInputSchema.safeParse(withDetours([{ detourId: 2, coverage: 0.5, extra: 1 }])).success).toBe(false)
    expect(ScorePostingInputSchema.safeParse(withDetours([{ detourId: 2, coverage: 0.5 }, { detourId: 2, coverage: 0 }])).success).toBe(false)
  })

  test('a score input refuses a requirement rated twice, a penalty kind used twice and an unknown key', () => {
    const base = { postingId: 1, criteriaSetId: 1, ratings: [rating], penalties: [] }
    expect(ScorePostingInputSchema.safeParse(base).success).toBe(true)
    expect(ScorePostingInputSchema.safeParse({ ...base, ratings: [rating, rating] }).success).toBe(false)
    const penalty = { penaltyKindId: 3, amount: -0.1 }
    expect(ScorePostingInputSchema.safeParse({ ...base, penalties: [penalty, penalty] }).success).toBe(false)
    expect(ScorePostingInputSchema.safeParse({ ...base, overall: 1 }).success).toBe(false)
  })

  test('the bulk form is the single form in a bounded, non-empty envelope', () => {
    const item = { postingId: 1, criteriaSetId: 1, ratings: [], penalties: [] }
    expect(ScorePostingBulkSchema.safeParse({ items: [item] }).success).toBe(true)
    expect(ScorePostingBulkSchema.safeParse({ items: Array.from({ length: BULK_MAX }, () => item) }).success).toBe(true)
    expect(ScorePostingBulkSchema.safeParse({ items: [] }).success).toBe(false)
    expect(ScorePostingBulkSchema.safeParse({ items: Array.from({ length: BULK_MAX + 1 }, () => item) }).success).toBe(false)
  })
})
