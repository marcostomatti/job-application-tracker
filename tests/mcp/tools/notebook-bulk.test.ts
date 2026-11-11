import { afterEach, describe, expect, test } from 'bun:test'

import { NotFoundError } from '../../../src/errors.ts'
import { NotebookClient } from '../../../src/notebook/client.ts'
import { notebookTools } from '../../../src/mcp/tools/notebook.ts'
import { BULK_STORE_MAX, BULK_STORE_TEXT_MAX } from '../../../src/schemas/notebook.ts'
import { startStubNotebook, type StubOptions, type StubServer } from '../../notebook/stub-server.ts'
import { connectTools, failureText, untouchableDb, type ToolClient } from './harness.ts'

/** The tracker side of a posting lookup, without a database: three known postings. */
const POSTING_KEYS = new Map<number, string>([
  [1, 'example-ab/backend-engineer'],
  [2, 'example-cd/platform-lead'],
  [3, 'example-ef/data-engineer'],
])

async function postingKeyOf(_db: unknown, postingId: number): Promise<string> {
  const key = POSTING_KEYS.get(postingId)
  if (key === undefined) throw new NotFoundError('posting', postingId)
  return key
}

let stub: StubServer | undefined

afterEach(async () => {
  await stub?.stop()
  stub = undefined
})

async function connect(
  options: StubOptions = {},
  bulkBudgetMs?: number,
): Promise<{ tools: ToolClient; notebookId: string; server: StubServer }> {
  const server = startStubNotebook({ password: 'pw', ...options })
  stub = server
  const client = new NotebookClient({ url: server.url, apiKey: 'pw' })
  const deps = bulkBudgetMs === undefined ? { client, postingKeyOf } : { client, postingKeyOf, bulkBudgetMs }
  const tools = await connectTools(notebookTools(deps), untouchableDb())
  const created = await tools.call('notebook_create', { name: 'Postings' })
  return { tools, notebookId: (created.body as { id: string }).id, server }
}

type BulkPostingResult = {
  stored: Array<{ postingId: number; postingKey: string; source: { id: string }; earlierSources: Array<{ id: string }> }>
  failed: { index: number; postingId: number; mayBeStored: boolean; error: { name: string; message: string } } | null
  notAttempted: number[]
  budgetReached: boolean
  earlierComplete: boolean
}

const postsOf = (server: StubServer): number =>
  server.requests.filter((request) => request.method === 'POST' && request.path === '/api/sources/json').length

describe('notebook_posting_store_bulk', () => {
  test('stores each posting titled with its key, in the order given', async () => {
    const { tools, notebookId, server } = await connect()

    const outcome = await tools.call('notebook_posting_store_bulk', {
      notebookId,
      items: [
        { postingId: 1, content: 'first text' },
        { postingId: 2, content: 'second text' },
      ],
    })

    expect(outcome.failed).toBe(false)
    const body = outcome.body as BulkPostingResult
    expect(body.stored.map((row) => row.postingKey)).toEqual(['example-ab/backend-engineer', 'example-cd/platform-lead'])
    expect(body.failed).toBeNull()
    expect(body.notAttempted).toEqual([])
    expect(server.sources.map((source) => [source.title, source.full_text])).toEqual([
      ['example-ab/backend-engineer', 'first text'],
      ['example-cd/platform-lead', 'second text'],
    ])
  })

  test('names earlier copies of each posting, read in one pass over the notebook, and deletes nothing', async () => {
    const { tools, notebookId, server } = await connect()
    const first = await tools.call('notebook_posting_store', { postingId: 2, notebookId, content: 'v1' })
    const earlierId = (first.body as { source: { id: string } }).source.id
    const listsBefore = server.requests.filter((request) => request.path === '/api/sources' && request.method === 'GET').length

    const outcome = await tools.call('notebook_posting_store_bulk', {
      notebookId,
      items: [
        { postingId: 1, content: 'a' },
        { postingId: 2, content: 'v2' },
      ],
    })

    const body = outcome.body as BulkPostingResult
    const lists = server.requests.filter((request) => request.path === '/api/sources' && request.method === 'GET').length - listsBefore
    expect(body.stored.map((row) => row.earlierSources.map((source) => source.id))).toEqual([[], [earlierId]])
    expect(body.earlierComplete).toBe(true)
    expect(lists).toBe(1)
    expect(server.sources).toHaveLength(3)
  })

  test('an unknown posting is a not-found error, and nothing is sent to the notebook', async () => {
    const { tools, notebookId, server } = await connect()

    const outcome = await tools.call('notebook_posting_store_bulk', {
      notebookId,
      items: [
        { postingId: 1, content: 'a' },
        { postingId: 99, content: 'b' },
      ],
    })

    expect(outcome.failed).toBe(true)
    expect(failureText(outcome)).toContain('posting 99 does not exist')
    expect(postsOf(server)).toBe(0)
  })

  test('stops at the first item the notebook refuses, and reports what was stored and what was not tried', async () => {
    const { tools, notebookId } = await connect({ failSourcesAfter: 1 })

    const outcome = await tools.call('notebook_posting_store_bulk', {
      notebookId,
      items: [
        { postingId: 1, content: 'a' },
        { postingId: 2, content: 'b' },
        { postingId: 3, content: 'c' },
      ],
    })

    expect(outcome.failed).toBe(false)
    const body = outcome.body as BulkPostingResult
    expect(body.stored.map((row) => row.postingId)).toEqual([1])
    expect(body.failed).toMatchObject({ index: 1, postingId: 2, mayBeStored: false, error: { name: 'NotebookRequestError' } })
    expect(body.notAttempted).toEqual([2])
    expect(body.budgetReached).toBe(false)
  })

  test('a lost answer marks the failed item as maybe stored, because the notebook may have kept it', async () => {
    const { tools, notebookId, server } = await connect({ garbleSourcesAfter: 1 })

    const outcome = await tools.call('notebook_posting_store_bulk', {
      notebookId,
      items: [
        { postingId: 1, content: 'a' },
        { postingId: 2, content: 'b' },
        { postingId: 3, content: 'c' },
      ],
    })

    const body = outcome.body as BulkPostingResult
    expect(body.stored.map((row) => row.postingId)).toEqual([1])
    expect(body.failed).toMatchObject({ index: 1, postingId: 2, mayBeStored: true, error: { name: 'NotebookUnavailableError' } })
    expect(body.notAttempted).toEqual([2])
    expect(server.sources.map((source) => source.title)).toEqual(['example-ab/backend-engineer', 'example-cd/platform-lead'])
  })

  test('past its time budget it starts no new item, and answers with the rest as not attempted', async () => {
    const { tools, notebookId, server } = await connect({}, 0)

    const outcome = await tools.call('notebook_posting_store_bulk', {
      notebookId,
      items: [
        { postingId: 1, content: 'a' },
        { postingId: 2, content: 'b' },
      ],
    })

    expect(outcome.failed).toBe(false)
    const body = outcome.body as BulkPostingResult
    expect(body).toMatchObject({ stored: [], failed: null, notAttempted: [0, 1], budgetReached: true })
    expect(postsOf(server)).toBe(0)
  })

  test('refuses a repeated posting, too many items and too much text, before any request', async () => {
    const { tools, notebookId, server } = await connect()
    const requestsBefore = server.requests.length

    const repeated = await tools.call('notebook_posting_store_bulk', {
      notebookId,
      items: [
        { postingId: 1, content: 'a' },
        { postingId: 1, content: 'b' },
      ],
    })
    const tooMany = await tools.call('notebook_posting_store_bulk', {
      notebookId,
      items: Array.from({ length: BULK_STORE_MAX + 1 }, (_, index) => ({ postingId: index + 1, content: 'x' })),
    })
    const half = Math.ceil(BULK_STORE_TEXT_MAX / 2) + 1
    const tooLong = await tools.call('notebook_posting_store_bulk', {
      notebookId,
      items: [
        { postingId: 1, content: 'x'.repeat(half) },
        { postingId: 2, content: 'x'.repeat(half) },
      ],
    })

    expect([repeated.failed, tooMany.failed, tooLong.failed]).toEqual([true, true, true])
    expect(server.requests.length).toBe(requestsBefore)
  })
})

describe('notebook_source_add_text_bulk', () => {
  test('stores each text with its own title, in the notebooks given, in order', async () => {
    const { tools, notebookId, server } = await connect()

    const outcome = await tools.call('notebook_source_add_text_bulk', {
      notebookIds: [notebookId],
      items: [
        { title: 'Notes one', content: 'one' },
        { title: 'Notes two', content: 'two' },
      ],
    })

    expect(outcome.failed).toBe(false)
    const body = outcome.body as { stored: Array<{ title: string; source: { id: string } }>; failed: unknown; notAttempted: number[] }
    expect(body.stored.map((row) => row.title)).toEqual(['Notes one', 'Notes two'])
    expect(body.failed).toBeNull()
    expect(server.sources.map((source) => [source.title, source.notebooks])).toEqual([
      ['Notes one', [notebookId]],
      ['Notes two', [notebookId]],
    ])
  })

  test('stops at the first refused text and reports the rest as not tried', async () => {
    const { tools, notebookId } = await connect({ failSourcesAfter: 0 })

    const outcome = await tools.call('notebook_source_add_text_bulk', {
      notebookIds: [notebookId],
      items: [
        { title: 'A', content: 'a' },
        { title: 'B', content: 'b' },
      ],
    })

    const body = outcome.body as { stored: unknown[]; failed: { index: number; mayBeStored: boolean }; notAttempted: number[] }
    expect(body.stored).toEqual([])
    expect(body.failed).toMatchObject({ index: 0, mayBeStored: false })
    expect(body.notAttempted).toEqual([1])
  })

  test('past its time budget it starts no new text either', async () => {
    const { tools, notebookId, server } = await connect({}, 0)

    const outcome = await tools.call('notebook_source_add_text_bulk', { notebookIds: [notebookId], items: [{ title: 'A', content: 'a' }] })

    expect(outcome.body).toMatchObject({ stored: [], failed: null, notAttempted: [0], budgetReached: true })
    expect(postsOf(server)).toBe(0)
  })
})
