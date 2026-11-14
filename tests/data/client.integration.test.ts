import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'

import { closeDb, getDb } from '../../src/data/client.ts'

const ORIGINAL_URL = process.env.DATABASE_URL

afterEach(async () => {
  await closeDb()
  if (ORIGINAL_URL === undefined) delete process.env.DATABASE_URL
  else process.env.DATABASE_URL = ORIGINAL_URL
})

afterAll(async () => {
  await closeDb()
})

describe('getDb', () => {
  test('connects to the database named by DATABASE_URL', async () => {
    // Arrange
    process.env.DATABASE_URL =
      ORIGINAL_URL ?? 'postgres://tracker:tracker@localhost:5432/tracker'

    // Act
    const rows = await getDb().execute(sql`select 1 as one`)

    // Assert
    expect(rows[0]?.one).toBe(1)
  })
})
