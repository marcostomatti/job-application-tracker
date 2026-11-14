import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { lintMigrations } from '../../drizzle/lint/migration-lint'
import { NewTextBulkSchema, NewTextSchema, TextQuerySchema, TextUpdateSchema } from '../../src/schemas/texts.ts'

const MIGRATIONS_DIR = join(import.meta.dir, '..', '..', 'drizzle')

describe('the unique index on (label, version)', () => {
  test('is added by a migration that passes the lint', () => {
    // Arrange
    const names = readdirSync(MIGRATIONS_DIR).filter((name) => /^0011_.*\.sql$/.test(name))
    expect(names).toHaveLength(1)
    const migration = join(MIGRATIONS_DIR, names[0] as string)

    // Act
    const sqlText = readFileSync(migration, 'utf8')
    const findings = lintMigrations(MIGRATIONS_DIR).filter((finding) => finding.file === migration)

    // Assert
    expect(sqlText).toMatch(/CREATE UNIQUE INDEX "text_asset_label_version_unique"/)
    expect(sqlText.match(/\bTABLE\b/g) ?? []).toEqual([])
    expect(findings).toEqual([])
  })
})

describe('the text input schemas', () => {
  test('a new text needs a label and a body, refuses NUL in either, and refuses unknown keys', () => {
    expect(NewTextSchema.parse({ label: ' Cover ', body: 'Hello' })).toEqual({ label: 'Cover', body: 'Hello' })
    expect(NewTextSchema.safeParse({ label: 'Cover', body: 'a\u0000b' }).success).toBe(false)
    expect(NewTextSchema.safeParse({ label: 'a\u0000', body: 'b' }).success).toBe(false)
    expect(NewTextSchema.safeParse({ label: '', body: 'b' }).success).toBe(false)
    expect(NewTextSchema.safeParse({ label: 'a', body: '' }).success).toBe(false)
    expect(NewTextSchema.safeParse({ label: 'a', body: 'b', version: 3 }).success).toBe(false)
  })

  test('keeps the body as written: its own line breaks and indentation are the user\'s', () => {
    expect(NewTextSchema.parse({ label: 'a', body: '  Dear Sam,\n\n  Hello\n' }).body).toBe('  Dear Sam,\n\n  Hello\n')
  })

  test('an update names the label and the new body, and may name a type or clear it', () => {
    expect(TextUpdateSchema.parse({ label: 'a', body: 'b', textTypeId: '3' })).toEqual({ label: 'a', body: 'b', textTypeId: 3 })
    expect(TextUpdateSchema.parse({ label: 'a', body: 'b', textTypeId: null }).textTypeId).toBeNull()
    expect(TextUpdateSchema.safeParse({ body: 'b' }).success).toBe(false)
    expect(TextUpdateSchema.safeParse({ label: 'a', body: 'b', version: 2 }).success).toBe(false)
  })

  test('a query takes a type id and includeHistory as a boolean or its text form, and nothing else', () => {
    expect(TextQuerySchema.parse({})).toEqual({})
    expect(TextQuerySchema.parse({ textTypeId: '2', includeHistory: 'true' })).toEqual({ textTypeId: 2, includeHistory: true })
    expect(TextQuerySchema.safeParse({ includeHistory: 'yes' }).success).toBe(false)
    expect(TextQuerySchema.safeParse({ limit: 5 }).success).toBe(false)
  })

  test('the bulk form takes a bounded, non-empty list', () => {
    expect(NewTextBulkSchema.safeParse({ items: [] }).success).toBe(false)
    expect(NewTextBulkSchema.safeParse({ items: [{ label: 'a', body: 'b' }] }).success).toBe(true)
  })
})
