import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { NotFoundError } from '../../../src/errors.ts'
import { NotebookClient } from '../../../src/notebook/client.ts'
import { ALL_TOOLS } from '../../../src/mcp/tools/index.ts'
import { NOTEBOOK_TOOL_NAMES, notebookTools } from '../../../src/mcp/tools/notebook.ts'
import { startStubNotebook, type StubServer } from '../../notebook/stub-server.ts'
import { connectTools, failureText, untouchableDb, type ToolClient } from './harness.ts'

/** The tracker side of a posting lookup, without a database: two known postings. */
const POSTING_KEYS = new Map<number, string>([
  [1, 'acme/staff-engineer'],
  [2, 'globex/platform-lead'],
])

async function postingKeyOf(_db: unknown, postingId: number): Promise<string> {
  const key = POSTING_KEYS.get(postingId)
  if (key === undefined) throw new NotFoundError('posting', postingId)
  return key
}

let stub: StubServer
let tools: ToolClient

beforeEach(async () => {
  stub = startStubNotebook({ password: 'pw' })
  const client = new NotebookClient({ url: stub.url, apiKey: 'pw' })
  // No notebook tool may touch the tracker database except through postingKeyOf.
  tools = await connectTools(notebookTools({ client, postingKeyOf }), untouchableDb())
})

afterEach(async () => {
  await stub.stop()
})

async function makeNotebook(name = 'Acme'): Promise<string> {
  const outcome = await tools.call('notebook_create', { name })
  expect(outcome.failed).toBe(false)
  return (outcome.body as { id: string }).id
}

describe('the notebook tool set', () => {
  test('its names are its own, and none collides with a tracker tool', () => {
    const tracker = new Set(ALL_TOOLS.map((tool) => tool.name))
    const names = notebookTools({ client: new NotebookClient({ url: 'http://127.0.0.1:1', apiKey: undefined }), postingKeyOf }).map(
      (tool) => tool.name,
    )
    expect(names).toEqual([...NOTEBOOK_TOOL_NAMES])
    for (const name of names) {
      expect(name.startsWith('notebook_')).toBe(true)
      expect(tracker.has(name)).toBe(false)
    }
  })

  test('only notebook_source_delete is marked destructive', () => {
    const set = notebookTools({ client: new NotebookClient({ url: 'http://127.0.0.1:1', apiKey: undefined }), postingKeyOf })
    const destructive = set.filter((tool) => tool.annotations?.destructiveHint === true).map((tool) => tool.name)
    expect(destructive).toEqual(['notebook_source_delete'])
  })
})

describe('notebooks and sources', () => {
  test('a created notebook is listed', async () => {
    const id = await makeNotebook('Globex')
    const listed = await tools.call('notebook_list', {})
    expect((listed.body as Array<{ id: string; name: string }>).map((row) => [row.id, row.name])).toEqual([[id, 'Globex']])
  })

  test('a text source is stored, listed and fetched in full', async () => {
    const notebookId = await makeNotebook()
    const added = await tools.call('notebook_source_add_text', { title: 'CV', content: 'ten years of work', notebookIds: [notebookId] })
    expect(added.failed).toBe(false)
    const sourceId = (added.body as { id: string }).id
    expect(stub.sources[0]?.embedded).toBe(true)

    const list = await tools.call('notebook_source_list', { notebookId })
    expect((list.body as Array<{ id: string }>).map((row) => row.id)).toEqual([sourceId])

    const got = await tools.call('notebook_source_get', { sourceId })
    expect(got.body).toMatchObject({ id: sourceId, title: 'CV', text: 'ten years of work', truncated: false, totalChars: 17 })
  })

  test('a long source comes back in windows the caller can page through', async () => {
    const notebookId = await makeNotebook()
    const added = await tools.call('notebook_source_add_text', { title: 'long', content: 'abcdefghij', notebookIds: [notebookId] })
    const sourceId = (added.body as { id: string }).id
    const first = await tools.call('notebook_source_get', { sourceId, maxChars: 4 })
    expect(first.body).toMatchObject({ text: 'abcd', textOffset: 0, truncated: true, totalChars: 10 })
    const last = await tools.call('notebook_source_get', { sourceId, offset: 8, maxChars: 4 })
    expect(last.body).toMatchObject({ text: 'ij', textOffset: 8, truncated: false })
  })

  test('a source is deleted', async () => {
    const notebookId = await makeNotebook()
    const added = await tools.call('notebook_source_add_text', { title: 'x', content: 'y', notebookIds: [notebookId] })
    const sourceId = (added.body as { id: string }).id
    expect((await tools.call('notebook_source_delete', { sourceId })).failed).toBe(false)
    expect(stub.sources).toHaveLength(0)
  })

  test('an id that is not a source id is refused before any request', async () => {
    const before = stub.requests.length
    const outcome = await tools.call('notebook_source_get', { sourceId: '../credentials' })
    expect(outcome.failed).toBe(true)
    expect(stub.requests.length).toBe(before)
  })

  test('an unknown source is a not-found error', async () => {
    const outcome = await tools.call('notebook_source_get', { sourceId: 'source:missing' })
    expect(outcome.failed).toBe(true)
    expect(failureText(outcome)).toContain('NotFoundError')
  })
})

describe('postings in the notebook', () => {
  test('a posting is stored under its posting key', async () => {
    const notebookId = await makeNotebook()
    const outcome = await tools.call('notebook_posting_store', { postingId: 1, notebookId, content: 'the posting text' })
    expect(outcome.failed).toBe(false)
    expect(outcome.body).toMatchObject({ postingKey: 'acme/staff-engineer', earlierSources: [] })
    expect(stub.sources[0]).toMatchObject({ title: 'acme/staff-engineer', full_text: 'the posting text', notebooks: [notebookId] })
  })

  test('storing again names the earlier copy, and deletes nothing', async () => {
    const notebookId = await makeNotebook()
    const first = await tools.call('notebook_posting_store', { postingId: 1, notebookId, content: 'v1' })
    const firstId = (first.body as { source: { id: string } }).source.id
    const second = await tools.call('notebook_posting_store', { postingId: 1, notebookId, content: 'v2' })
    expect((second.body as { earlierSources: Array<{ id: string }> }).earlierSources.map((s) => s.id)).toEqual([firstId])
    expect(stub.sources).toHaveLength(2)
  })

  test('an unknown posting is a not-found error and stores nothing', async () => {
    const notebookId = await makeNotebook()
    const outcome = await tools.call('notebook_posting_store', { postingId: 99, notebookId, content: 'x' })
    expect(outcome.failed).toBe(true)
    expect(failureText(outcome)).toContain('posting 99 does not exist')
    expect(stub.sources).toHaveLength(0)
  })

  test('a posting\'s sources are found by its key, and no one else\'s', async () => {
    const notebookId = await makeNotebook()
    await tools.call('notebook_posting_store', { postingId: 1, notebookId, content: 'a' })
    await tools.call('notebook_posting_store', { postingId: 2, notebookId, content: 'b' })
    const found = await tools.call('notebook_posting_sources', { postingId: 2 })
    expect(found.body).toMatchObject({ postingKey: 'globex/platform-lead', complete: true })
    expect((found.body as { sources: Array<{ title: string }> }).sources.map((s) => s.title)).toEqual(['globex/platform-lead'])
  })

  test('the lookup pages past the notebook\'s 100-source page', async () => {
    const notebookId = await makeNotebook()
    for (let index = 0; index < 120; index += 1) {
      stub.sources.push({ id: `source:filler${index}`, title: `other ${index}`, full_text: '', notebooks: [notebookId], embedded: false, created: 'x' })
    }
    stub.sources.push({ id: 'source:late', title: 'acme/staff-engineer', full_text: '', notebooks: [notebookId], embedded: false, created: 'x' })
    const found = await tools.call('notebook_posting_sources', { postingId: 1, notebookId })
    expect((found.body as { sources: Array<{ id: string }> }).sources.map((s) => s.id)).toEqual(['source:late'])
  })
})

describe('search and notes', () => {
  test('search sends the scope and returns the notebook\'s results', async () => {
    const notebookId = await makeNotebook()
    await tools.call('notebook_source_add_text', { title: 'CV', content: 'led a payments team', notebookIds: [notebookId] })
    const outcome = await tools.call('notebook_search', { query: 'payments', notebookId })
    expect(outcome.body).toMatchObject({ total: 1, searchType: 'text' })
    expect(stub.requests.at(-1)?.body).toMatchObject({ query: 'payments', type: 'text', notebook_id: notebookId, search_sources: true, search_notes: true })
  })

  test('a note is added to a notebook', async () => {
    const notebookId = await makeNotebook()
    const outcome = await tools.call('notebook_note_add', { notebookId, title: 'past work', content: 'ran on-call for two years' })
    expect(outcome.failed).toBe(false)
    expect(stub.notes[0]).toMatchObject({ notebook_id: notebookId, note_type: 'human', content: 'ran on-call for two years' })
  })
})

describe('a notebook that goes away mid-session', () => {
  test('each call fails with an unavailable error, and the next call tries again', async () => {
    await stub.stop()
    const outcome = await tools.call('notebook_list', {})
    expect(outcome.failed).toBe(true)
    expect(failureText(outcome)).toContain('NotebookUnavailableError')
    // Restart on a new port is a new configuration; the point is that no state was poisoned.
    stub = startStubNotebook({ password: 'pw' })
  })
})
