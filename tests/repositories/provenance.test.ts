import { describe, expect, test } from 'bun:test'

import * as repositoryModule from '../../src/data/repositories/provenance.ts'
import {
  OriginBulkSchema,
  OriginInputSchema,
  SearchRunInputSchema,
} from '../../src/schemas/provenance.ts'

describe('the module', () => {
  test('exports no second copy of the checks Tasks 4 and 7 own', () => {
    expect(Object.keys(repositoryModule)).not.toContain('isApplied')
    expect(Object.keys(repositoryModule)).not.toContain('summaryChanged')
  })
})

describe('the provenance input schemas', () => {
  test('an origin input needs a real calendar day and refuses unknown keys, NUL and an empty note', () => {
    expect(OriginInputSchema.parse({ touchedOn: '2026-01-05' })).toEqual({ touchedOn: '2026-01-05' })
    expect(OriginInputSchema.safeParse({}).success).toBe(false)
    expect(OriginInputSchema.safeParse({ touchedOn: '2026-02-30' }).success).toBe(false)
    expect(OriginInputSchema.safeParse({ touchedOn: '2026-01-05', recordedAt: '2020-01-01' }).success).toBe(false)
    expect(OriginInputSchema.safeParse({ touchedOn: '2026-01-05', note: 'a\u0000b' }).success).toBe(false)
    expect(OriginInputSchema.safeParse({ touchedOn: '2026-01-05', note: '   ' }).success).toBe(false)
  })

  test('ids arrive as numbers or numeric text, and null clears a reference', () => {
    expect(OriginInputSchema.parse({ touchedOn: '2026-01-05', postingId: '4', routeId: null })).toEqual({
      touchedOn: '2026-01-05',
      postingId: 4,
      routeId: null,
    })
    expect(OriginInputSchema.safeParse({ touchedOn: '2026-01-05', postingId: 0 }).success).toBe(false)
  })

  test('a search run needs a query and a source, free of NUL', () => {
    expect(SearchRunInputSchema.parse({ query: ' staff ', source: 'a board' })).toEqual({ query: 'staff', source: 'a board' })
    expect(SearchRunInputSchema.safeParse({ query: '', source: 'a board' }).success).toBe(false)
    expect(SearchRunInputSchema.safeParse({ query: 'q', source: 'a\u0000' }).success).toBe(false)
    expect(SearchRunInputSchema.safeParse({ query: 'q', source: 's', extra: 1 }).success).toBe(false)
  })

  test('the bulk forms take a bounded, non-empty list', () => {
    expect(OriginBulkSchema.safeParse({ items: [] }).success).toBe(false)
    expect(OriginBulkSchema.safeParse({ items: [{ touchedOn: '2026-01-05' }] }).success).toBe(true)
  })
})
