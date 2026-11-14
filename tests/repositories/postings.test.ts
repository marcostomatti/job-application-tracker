import { describe, expect, test } from 'bun:test'

import { BULK_MAX, bulkOf } from '../../src/schemas/common.ts'
import {
  CompanyInputSchema,
  PostingInputSchema,
  PostingPatchSchema,
  PostingQuerySchema,
} from '../../src/schemas/postings.ts'
import { SummaryInputSchema } from '../../src/schemas/summaries.ts'

describe('the posting input schemas', () => {
  const minimal = { company: { name: 'Acme' }, roleTitle: 'Staff Engineer' }

  test('cannot carry a hand-ranking, and no other write schema can either', () => {
    // Assert: strictness is what makes the rule impossible rather than merely unused
    expect(PostingInputSchema.safeParse({ ...minimal, priorityRank: 1 }).success).toBe(false)
    expect(bulkOf(PostingInputSchema).safeParse({ items: [{ ...minimal, priorityRank: 1 }] }).success).toBe(false)
    expect(Object.keys(PostingInputSchema.shape)).not.toContain('priorityRank')
    expect(Object.keys(SummaryInputSchema.shape)).not.toContain('priorityRank')
    expect(Object.keys(CompanyInputSchema.shape)).not.toContain('priorityRank')
    expect(Object.keys(PostingPatchSchema.shape)).toContain('priorityRank')
  })

  test('refuses a field it does not name, so an import cannot set the import timestamps', () => {
    // Assert
    expect(PostingInputSchema.safeParse({ ...minimal, lastImportedAt: '2026-01-01' }).success).toBe(false)
    expect(PostingInputSchema.safeParse({ ...minimal, companyId: 3 }).success).toBe(false)
  })

  test('accepts a call of BULK_MAX items and refuses one more', () => {
    // Arrange
    const bulk = bulkOf(PostingInputSchema)
    const items = (n: number) => Array.from({ length: n }, () => minimal)

    // Assert
    expect(bulk.safeParse({ items: items(BULK_MAX) }).success).toBe(true)
    expect(bulk.safeParse({ items: items(BULK_MAX + 1) }).success).toBe(false)
  })

  test('refuses a NUL character, which Postgres cannot store, before it reaches the driver', () => {
    // Assert: refused as a validation message, so it never becomes a driver error with SQL in it
    expect(PostingInputSchema.safeParse({ ...minimal, roleTitle: 'a\u0000b' }).success).toBe(false)
    expect(PostingInputSchema.safeParse({ ...minimal, company: { name: 'a\u0000b' } }).success).toBe(false)
    expect(PostingInputSchema.safeParse({ ...minimal, disambiguator: 'a\u0000b' }).success).toBe(false)
    expect(PostingInputSchema.safeParse({ ...minimal, city: 'a\u0000b' }).success).toBe(false)
    expect(PostingPatchSchema.safeParse({ applyContact: 'a\u0000b' }).success).toBe(false)
  })

  test('refuses a blank company or role, and a date that is not a day', () => {
    // Assert
    expect(PostingInputSchema.safeParse({ ...minimal, roleTitle: '   ' }).success).toBe(false)
    expect(PostingInputSchema.safeParse({ ...minimal, company: { name: '' } }).success).toBe(false)
    expect(PostingInputSchema.safeParse({ ...minimal, deadline: 'soon' }).success).toBe(false)
  })
})

describe('the posting query schema', () => {
  test('composes the filters with pagination, so a filter does not trip the strict page schema', () => {
    // Act: a query string carries every value as text
    const parsed = PostingQuerySchema.parse({ companyId: '3', limit: '10', setAside: 'only' })

    // Assert
    expect(parsed).toMatchObject({ companyId: 3, limit: 10, offset: 0, setAside: 'only' })
  })

  test('still refuses a key it does not name', () => {
    // Assert
    expect(PostingQuerySchema.safeParse({ company: 3 }).success).toBe(false)
    expect(PostingQuerySchema.safeParse({ setAside: 'maybe' }).success).toBe(false)
  })

  test('defaults to hiding set-aside and client-hidden postings', () => {
    // Assert
    expect(PostingQuerySchema.parse({}).setAside).toBe('exclude')
    expect(PostingQuerySchema.parse({}).clientHidden).toBe('exclude')
    expect(PostingQuerySchema.safeParse({ clientHidden: 'maybe' }).success).toBe(false)
  })
})

describe('updatePosting', () => {
  test('the patch schema refuses a field that is not editable and an empty patch', () => {
    // Assert
    expect(PostingPatchSchema.safeParse({ priorityRank: 1 }).success).toBe(true)
    expect(PostingPatchSchema.safeParse({ companyId: 2 }).success).toBe(false)
    expect(PostingPatchSchema.safeParse({ postingKey: 'x' }).success).toBe(false)
    expect(PostingPatchSchema.safeParse({ firstImportedAt: '2026-01-01' }).success).toBe(false)
    expect(PostingPatchSchema.safeParse({}).success).toBe(false)
  })
})
