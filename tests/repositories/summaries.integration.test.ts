import { describe, expect, test } from 'bun:test'
import { count } from 'drizzle-orm'

import { addPostings } from '../../src/data/repositories/postings.ts'
import { getSummary, summaryChanged, writeSummary } from '../../src/data/repositories/summaries.ts'
import { postingSummary } from '../../src/data/schema/postings.ts'
import { NotFoundError } from '../../src/errors.ts'
import { thrownBy } from '../data/rolled-back.ts'
import { withMigratedScratchDatabase } from '../data/scratch-database.ts'
import type { DrizzleClient } from '../../src/data/client.ts'

async function newPostingId(db: DrizzleClient, title = 'Staff Engineer'): Promise<number> {
  const [added] = await addPostings(db, [{ company: { name: 'Acme' }, roleTitle: title }])
  if (!added) throw new Error('the arrangement stored no posting')
  return added.id
}

describe('writeSummary and getSummary', () => {
  test('stores a summary and reads it back, with defaults for what the caller left out', async () => {
    // Arrange / Act
    const { written, read } = await withMigratedScratchDatabase(async (db) => {
      const postingId = await newPostingId(db)
      const written = await writeSummary(db, { postingId, condensed: 'The posting, condensed', sourceHash: 'h1' })
      return { written, read: await getSummary(db, postingId) }
    })

    // Assert
    expect(read).toEqual(written)
    expect(read?.stack).toEqual([])
    expect(read?.extra).toEqual({})
    expect(read?.description).toBeNull()
    expect(read?.industry).toBeNull()
    expect(read?.sourceHash).toBe('h1')
  })

  test('keeps the stack and the extra payload as data', async () => {
    // Arrange / Act
    const read = await withMigratedScratchDatabase(async (db) => {
      const postingId = await newPostingId(db)
      await writeSummary(db, {
        postingId,
        stack: ['typescript', 'postgres'],
        description: 'A role',
        industry: 'A sector',
        condensed: 'Condensed',
        extra: { team: { size: 6 }, remote: true },
        sourceHash: 'h1',
      })
      return getSummary(db, postingId)
    })

    // Assert
    expect(read?.stack).toEqual(['typescript', 'postgres'])
    expect(read?.extra).toEqual({ team: { size: 6 }, remote: true })
    expect(read?.industry).toBe('A sector')
  })

  test('replaces the summary on a second write, so a repost leaves one row with the new hash', async () => {
    // Arrange / Act: a pause longer than the clock's resolution separates the two stamps
    const { first, second, rows } = await withMigratedScratchDatabase(async (db) => {
      const postingId = await newPostingId(db)
      const first = await writeSummary(db, { postingId, condensed: 'Old', description: 'Gone', sourceHash: 'h1' })
      await Bun.sleep(25)
      const second = await writeSummary(db, { postingId, condensed: 'New', sourceHash: 'h2' })
      const [found] = await db.select({ n: count() }).from(postingSummary)
      return { first, second, rows: found?.n }
    })

    // Assert: replaced in full (the old description does not survive), and re-stamped later
    expect(rows).toBe(1)
    expect(second.condensed).toBe('New')
    expect(second.description).toBeNull()
    expect(second.sourceHash).toBe('h2')
    expect(second.summarisedAt.getTime()).toBeGreaterThan(first.summarisedAt.getTime())
  })

  test('refuses a summary for a posting that does not exist', async () => {
    // Arrange / Act
    const error = await withMigratedScratchDatabase((db) =>
      thrownBy(() => writeSummary(db, { postingId: 4242, condensed: 'Orphan', sourceHash: 'h1' })),
    )

    // Assert
    expect(error).toBeInstanceOf(NotFoundError)
  })

  test('reads null for a posting that has no summary yet, and not found for one that does not exist', async () => {
    // Arrange / Act
    const { bare, error } = await withMigratedScratchDatabase(async (db) => ({
      bare: await getSummary(db, await newPostingId(db)),
      error: await thrownBy(() => getSummary(db, 4242)),
    }))

    // Assert
    expect(bare).toBeNull()
    expect(error).toBeInstanceOf(NotFoundError)
  })
})

describe('summaryChanged', () => {
  test('is true for a different hash and false for the same one', async () => {
    // Arrange / Act
    const { same, different } = await withMigratedScratchDatabase(async (db) => {
      const postingId = await newPostingId(db)
      await writeSummary(db, { postingId, condensed: 'Condensed', sourceHash: 'h1' })
      return {
        same: await summaryChanged(db, postingId, 'h1'),
        different: await summaryChanged(db, postingId, 'h2'),
      }
    })

    // Assert
    expect(same).toBe(false)
    expect(different).toBe(true)
  })

  test('is true when no summary has been stored, because there is nothing to match', async () => {
    // Arrange / Act
    const changed = await withMigratedScratchDatabase(async (db) => summaryChanged(db, await newPostingId(db), 'h1'))

    // Assert
    expect(changed).toBe(true)
  })

  test('follows the stored hash, so it flips once the changed posting is written', async () => {
    // Arrange / Act
    const { before, after } = await withMigratedScratchDatabase(async (db) => {
      const postingId = await newPostingId(db)
      await writeSummary(db, { postingId, condensed: 'Condensed', sourceHash: 'h1' })
      const before = await summaryChanged(db, postingId, 'h2')
      await writeSummary(db, { postingId, condensed: 'Reposted', sourceHash: 'h2' })
      return { before, after: await summaryChanged(db, postingId, 'h2') }
    })

    // Assert
    expect(before).toBe(true)
    expect(after).toBe(false)
  })

  test('raises NotFoundError for a posting that does not exist', async () => {
    // Arrange / Act
    const error = await withMigratedScratchDatabase((db) => thrownBy(() => summaryChanged(db, 4242, 'h1')))

    // Assert
    expect(error).toBeInstanceOf(NotFoundError)
  })
})
