import { afterEach, describe, expect, test } from 'bun:test'

import { closeDb, getDb, MissingDatabaseUrlError } from '../../src/data/client.ts'

const ORIGINAL_URL = process.env.DATABASE_URL

afterEach(async () => {
  await closeDb()
  if (ORIGINAL_URL === undefined) delete process.env.DATABASE_URL
  else process.env.DATABASE_URL = ORIGINAL_URL
})

describe('getDb', () => {
  test('throws a named error when DATABASE_URL is absent', () => {
    // Arrange
    delete process.env.DATABASE_URL

    // Act
    const act = () => getDb()

    // Assert
    expect(act).toThrow(MissingDatabaseUrlError)
    expect(act).toThrow(/DATABASE_URL/)
    expect(act).not.toThrow(TypeError)
  })
})
