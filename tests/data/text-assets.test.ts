import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { lintMigrations } from '../../drizzle/lint/migration-lint'

const MIGRATIONS_DIR = join(import.meta.dir, '..', '..', 'drizzle')

/** The migration drizzle-kit numbered 0009, whatever name it generated for it. */
function textAssetMigration(): string {
  const names = readdirSync(MIGRATIONS_DIR).filter((name) => /^0009_.*\.sql$/.test(name))
  expect(names).toHaveLength(1)
  return join(MIGRATIONS_DIR, names[0] as string)
}

describe('text_asset', () => {
  test('the migration passes the lint and names no text type', () => {
    // Arrange
    const migration = textAssetMigration()

    // Act
    const findings = lintMigrations(MIGRATIONS_DIR).filter((finding) => finding.file === migration)
    const sqlText = readFileSync(migration, 'utf8').toLowerCase()

    // Assert
    expect(findings).toEqual([])
    expect(sqlText).not.toContain('cover letter')
  })
})
