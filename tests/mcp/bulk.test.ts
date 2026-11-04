import { describe, expect, test } from 'bun:test'

import { addPostings, searchPostings } from '../../src/data/repositories/postings.ts'
import { PostingQuerySchema } from '../../src/schemas/postings.ts'
import { ArchivedError, BulkItemError, ConflictError, NotFoundError } from '../../src/errors.ts'
import { inOneTransaction } from '../../src/mcp/bulk.ts'
import { describeError } from '../../src/mcp/result.ts'
import { thrownBy } from '../data/rolled-back.ts'
import { useSharedScratchDatabase } from './tools/harness.ts'

const database = useSharedScratchDatabase()

async function titlesStored(prefix: string): Promise<string[]> {
  const rows = await searchPostings(database(), PostingQuerySchema.parse({ limit: 200 }))
  return rows.map((row) => row.posting.roleTitle).filter((title) => title.startsWith(prefix))
}

/** Writes one posting named after the item, so a test can see which items survived. */
async function writeOne(tx: Parameters<typeof addPostings>[0], title: string): Promise<string> {
  await addPostings(tx, [{ company: { name: 'Helper Co' }, roleTitle: title }])
  return title
}

describe('inOneTransaction', () => {
  test('returns each item\'s result in the order the items were given', async () => {
    const results = await inOneTransaction(database(), ['ok-b', 'ok-a'], (tx, title) => writeOne(tx, title))

    expect(results).toEqual(['ok-b', 'ok-a'])
    expect((await titlesStored('ok-')).sort()).toEqual(['ok-a', 'ok-b'])
  })

  test('raises a BulkItemError with the failing index and the real cause, and writes none of the batch', async () => {
    const failure = await thrownBy(() =>
      inOneTransaction(database(), ['half-0', 'half-1', 'half-2'], async (tx, title, index) => {
        await writeOne(tx, title)
        if (index === 1) throw new NotFoundError('widget', 7)
      }),
    )

    expect(failure).toBeInstanceOf(BulkItemError)
    expect(failure).toMatchObject({ index: 1, cause: expect.any(NotFoundError) })
    expect(await titlesStored('half-')).toEqual([])
  })

  test.each([
    ['a conflict', () => new ConflictError('thing', 'k')],
    ['an archived row', () => new ArchivedError('thing', 3)],
    ['a missing row', () => new NotFoundError('thing', 3)],
  ])('treats %s as a fault of the item', async (_label, makeFault) => {
    const failure = await thrownBy(() =>
      inOneTransaction(database(), [0], async () => {
        throw makeFault()
      }),
    )

    expect(failure).toBeInstanceOf(BulkItemError)
    expect(failure).toMatchObject({ index: 0 })
  })

  test('rethrows a fault that is not about the item unchanged, and still writes none of the batch', async () => {
    const outage = new Error('connection lost')

    const failure = await thrownBy(() =>
      inOneTransaction(database(), ['out-0', 'out-1'], async (tx, title, index) => {
        await writeOne(tx, title)
        if (index === 1) throw outage
      }),
    )

    expect(failure).toBe(outage)
    expect(await titlesStored('out-')).toEqual([])
  })

  test('runs every item in one transaction opened on the database it was given', async () => {
    let opened = 0
    const counting = new Proxy(database(), {
      get(target, property): unknown {
        const member: unknown = Reflect.get(target, property, target)
        if (property !== 'transaction' || typeof member !== 'function') return member
        return (...args: unknown[]): unknown => {
          opened += 1
          return member.apply(target, args)
        }
      },
    })

    await inOneTransaction(counting, ['one-a', 'one-b', 'one-c'], (tx, title) => writeOne(tx, title))

    expect(opened).toBe(1)
  })

  test('an empty list returns an empty list without calling the per-item function', async () => {
    let called = 0

    const results = await inOneTransaction(database(), [], async () => {
      called += 1
    })

    expect(results).toEqual([])
    expect(called).toBe(0)
  })

  test('a BulkItemError from an item is wrapped with this level\'s index and keeps the inner one on its cause', async () => {
    const inner = new BulkItemError(0, new NotFoundError('route', 9))

    const failure = await thrownBy(() =>
      inOneTransaction(database(), ['nest-0', 'nest-1', 'nest-2'], async (tx, title, index) => {
        await writeOne(tx, title)
        if (index === 2) throw inner
      }),
    )

    expect(failure).toBeInstanceOf(BulkItemError)
    expect(failure).toMatchObject({ index: 2, cause: inner })
    // describeError adds one level of cause, so the inner reason itself stays on `cause` only.
    expect(describeError(failure).message).toBe('bulk item 2 failed: bulk item 0 failed')
    expect(await titlesStored('nest-')).toEqual([])
  })
})
