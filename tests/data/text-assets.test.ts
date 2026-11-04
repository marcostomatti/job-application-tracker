import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { lintMigrations } from '../../drizzle/lint/migration-lint'
import { textAsset } from '../../src/data/schema/texts.ts'
import { withMigratedScratchDatabase } from './scratch-database.ts'

const MIGRATIONS_DIR = join(import.meta.dir, '..', '..', 'drizzle')

/** The migration drizzle-kit numbered 0009, whatever name it generated for it. */
function textAssetMigration(): string {
  const names = readdirSync(MIGRATIONS_DIR).filter((name) => /^0009_.*\.sql$/.test(name))
  expect(names).toHaveLength(1)
  return join(MIGRATIONS_DIR, names[0] as string)
}

describe('text_asset', () => {
  test('ships empty and a label with a null type is allowed', async () => {
    await withMigratedScratchDatabase(async (db, sql) => {
      // Arrange
      const counted = await sql`SELECT count(*)::int AS n FROM text_asset`

      // Act
      await db.insert(textAsset).values({ label: 'a', body: 'b' })
      const rows = await db.select().from(textAsset)

      // Assert
      expect(counted[0]?.n).toBe(0)
      expect(rows[0]?.version).toBe(1)
      expect(rows[0]?.textTypeId).toBeNull()
      expect(rows[0]?.createdAt).toBeInstanceOf(Date)
    })
  })

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
