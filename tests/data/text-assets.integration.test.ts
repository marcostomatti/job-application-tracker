import { describe, expect, test } from 'bun:test'

import { textAsset } from '../../src/data/schema/texts.ts'
import { withMigratedScratchDatabase } from './scratch-database.ts'

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
})
