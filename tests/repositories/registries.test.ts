import { describe, expect, test } from 'bun:test'

import { REGISTRY_TABLES } from '../../src/data/repositories/registries.ts'
import { BULK_MAX, bulkOf, IdSchema, PAGE_LIMIT_MAX, PaginationSchema } from '../../src/schemas/common.ts'
import { REGISTRY_SCHEMAS } from '../../src/schemas/registries.ts'

const REGISTRY_NAMES = [
  'apply_route',
  'artefact_kind',
  'layer',
  'penalty_kind',
  'phase',
  'rejection_reason',
  'route',
  'seniority',
  'set_aside_reason',
  'stage',
  'text_type',
  'work_format',
]

describe('the registry record', () => {
  test('every registry in the spec has a table and a schema', () => {
    // Assert: twelve registries, and the two records agree, so a thirteenth added to one
    // of them fails here until it is added to both
    expect(Object.keys(REGISTRY_TABLES).sort()).toEqual(REGISTRY_NAMES)
    expect(Object.keys(REGISTRY_SCHEMAS).sort()).toEqual(Object.keys(REGISTRY_TABLES).sort())
  })
})

describe('the bulk envelope', () => {
  test('rejects more than BULK_MAX items at the schema', () => {
    // Arrange / Act
    const parsed = bulkOf(REGISTRY_SCHEMAS.route).safeParse({
      items: Array(BULK_MAX + 1).fill({ label: 'x' }),
    })

    // Assert
    expect(parsed.success).toBe(false)
  })

  test('accepts exactly BULK_MAX items and refuses an empty list', () => {
    // Arrange
    const schema = bulkOf(REGISTRY_SCHEMAS.route)

    // Act
    const atTheCap = schema.safeParse({ items: Array(BULK_MAX).fill({ label: 'x' }) })
    const empty = schema.safeParse({ items: [] })

    // Assert
    expect(atTheCap.success).toBe(true)
    expect(empty.success).toBe(false)
  })

  test('refuses a key beside items, as the items themselves refuse a stray field', () => {
    // Act: a caller that believed the envelope took a limit would otherwise lose it silently
    const parsed = bulkOf(REGISTRY_SCHEMAS.route).safeParse({ items: [{ label: 'x' }], limit: 10 })

    // Assert
    expect(parsed.success).toBe(false)
  })
})

describe('the registry schemas', () => {
  test('refuse a blank label and trim the one they accept', () => {
    // Act
    const blank = REGISTRY_SCHEMAS.route.safeParse({ label: '   ' })
    const padded = REGISTRY_SCHEMAS.route.safeParse({ label: '  Careers page  ' })

    // Assert
    expect(blank.success).toBe(false)
    expect(padded.success && padded.data.label).toBe('Careers page')
  })

  test('refuse a field the registry does not have', () => {
    // Act: a flag only phase carries, sent to a registry that has no flags
    const parsed = REGISTRY_SCHEMAS.route.safeParse({ label: 'Careers page', isShortlist: true })

    // Assert
    expect(parsed.success).toBe(false)
  })

  test('require the key that a keyed registry has', () => {
    // Act
    const withoutKey = REGISTRY_SCHEMAS.phase.safeParse({ label: 'A phase' })
    const withKey = REGISTRY_SCHEMAS.phase.safeParse({ key: 'p1', label: 'A phase' })

    // Assert
    expect(withoutKey.success).toBe(false)
    expect(withKey.success).toBe(true)
  })
})

describe('the shared input schemas', () => {
  test('IdSchema takes a number or the numeric string an HTTP path carries', () => {
    // Act / Assert
    expect(IdSchema.parse(7)).toBe(7)
    expect(IdSchema.parse('7')).toBe(7)
    expect(IdSchema.safeParse(0).success).toBe(false)
    expect(IdSchema.safeParse(-1).success).toBe(false)
    expect(IdSchema.safeParse(1.5).success).toBe(false)
    expect(IdSchema.safeParse('').success).toBe(false)
    expect(IdSchema.safeParse(true).success).toBe(false)
  })

  test('PaginationSchema fills in a page when the caller asks for none', () => {
    // Act
    const defaults = PaginationSchema.parse({})
    const fromQueryString = PaginationSchema.parse({ limit: '10', offset: '20' })

    // Assert
    expect(defaults.offset).toBe(0)
    expect(defaults.limit).toBeGreaterThan(0)
    expect(fromQueryString).toEqual({ limit: 10, offset: 20 })
  })

  test('PaginationSchema refuses a limit no single-user database should serve', () => {
    // Act / Assert
    expect(PaginationSchema.safeParse({ limit: 0 }).success).toBe(false)
    expect(PaginationSchema.safeParse({ limit: PAGE_LIMIT_MAX + 1 }).success).toBe(false)
    expect(PaginationSchema.safeParse({ offset: -1 }).success).toBe(false)
  })

  test('PaginationSchema refuses a field it does not have, rather than dropping it', () => {
    // Act / Assert: a misspelled or invented page option is a mistake worth reporting
    expect(PaginationSchema.safeParse({ limit: 10, page: 3 }).success).toBe(false)
  })
})
