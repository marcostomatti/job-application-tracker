import { describe, expect, test } from 'bun:test'

import { findPostingKey } from '../../src/data/repositories/posting-key.ts'
import { addPostings } from '../../src/data/repositories/postings.ts'
import { NotFoundError } from '../../src/errors.ts'
import { withMigratedScratchDatabase } from '../data/scratch-database.ts'

describe('findPostingKey', () => {
  test('returns the key the posting was stored under', async () => {
    // Arrange / Act
    const { stored, found } = await withMigratedScratchDatabase(async (db) => {
      const [added] = await addPostings(db, [{ company: { name: 'Acme' }, roleTitle: 'Staff Engineer' }])
      if (!added) throw new Error('the arrangement stored no posting')
      return { stored: added.postingKey, found: await findPostingKey(db, added.id) }
    })

    // Assert
    expect(found).toBe(stored)
  })

  test('an unknown posting is a not-found error', async () => {
    // Arrange / Act
    const error = await withMigratedScratchDatabase(async (db) => findPostingKey(db, 999_999).catch((caught: unknown) => caught))

    // Assert
    expect(error).toBeInstanceOf(NotFoundError)
  })
})
