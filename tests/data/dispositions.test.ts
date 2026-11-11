import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { lintMigrations } from '../../drizzle/lint/migration-lint'

const MIGRATIONS_DIR = join(import.meta.dir, '..', '..', 'drizzle')

describe('dispositions and stage history', () => {
  test('the migration passes the lint', () => {
    // Arrange
    const migration = join(MIGRATIONS_DIR, '0004_dispositions.sql')

    // Act
    const findings = lintMigrations(MIGRATIONS_DIR).filter((finding) => finding.file === migration)

    // Assert: the file must exist, or "no findings" would pass for the wrong reason
    expect(existsSync(migration)).toBe(true)
    expect(findings).toEqual([])
  })
})
