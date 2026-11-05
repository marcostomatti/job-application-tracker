import { afterEach, describe, expect, test } from 'bun:test'

import { NotebookRequestError, NotebookUnavailableError, NotFoundError } from '../../src/errors.ts'
import { NotebookClient } from '../../src/notebook/client.ts'
import { probeNotebook } from '../../src/notebook/probe.ts'
import { startStubNotebook, type StubServer } from './stub-server.ts'

let stub: StubServer | undefined

afterEach(async () => {
  await stub?.stop()
  stub = undefined
})

function clientFor(server: StubServer, apiKey?: string, timeoutMs?: number): NotebookClient {
  return new NotebookClient({ url: server.url, apiKey }, timeoutMs === undefined ? {} : { timeoutMs })
}

describe('NotebookClient', () => {
  test('sends the key as a bearer token', async () => {
    stub = startStubNotebook({ password: 'pw' })
    await clientFor(stub, 'pw').listNotebooks({})
    expect(stub.requests[0]?.authorization).toBe('Bearer pw')
  })

  test('sends no authorization header when no key is set', async () => {
    stub = startStubNotebook()
    await clientFor(stub).listNotebooks({})
    expect(stub.requests[0]?.authorization).toBeNull()
  })

  test('creates a notebook and lists it back in camelCase', async () => {
    stub = startStubNotebook()
    const client = clientFor(stub)
    const created = await client.createNotebook({ name: 'Acme', description: 'research' })
    expect(created.id).toMatch(/^notebook:/)
    const listed = await client.listNotebooks({})
    expect(listed).toEqual([
      { id: created.id, name: 'Acme', description: 'research', archived: false, sourceCount: 0, noteCount: 0, updated: expect.any(String) },
    ])
  })

  test('adds a text source with embedding on and async processing', async () => {
    stub = startStubNotebook()
    const client = clientFor(stub)
    const notebook = await client.createNotebook({ name: 'N', description: '' })
    const source = await client.addTextSource({ title: 't', content: 'body', notebookIds: [notebook.id], embed: true })
    expect(source.id).toMatch(/^source:/)
    const sent = stub.requests.at(-1)
    expect(sent?.path).toBe('/api/sources/json')
    expect(sent?.body).toEqual({ type: 'text', title: 't', content: 'body', notebooks: [notebook.id], embed: true, async_processing: true })
  })

  test('an unknown source id is a not-found error', async () => {
    stub = startStubNotebook()
    await expect(clientFor(stub).getSource('source:nothing')).rejects.toBeInstanceOf(NotFoundError)
  })

  test('a 401 says the key was refused and names the variable', async () => {
    stub = startStubNotebook({ password: 'pw' })
    const error = await clientFor(stub, 'wrong').listNotebooks({}).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(NotebookRequestError)
    expect((error as Error).message).toContain('OPEN_NOTEBOOK_API_KEY')
  })

  test('a 500 never repeats the notebook\'s own error text', async () => {
    stub = startStubNotebook({ failWith: 500 })
    const error = await clientFor(stub).listNotebooks({}).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(NotebookRequestError)
    expect((error as Error).message).not.toContain('secret internals')
  })

  test('a notebook that went away mid-session is reported as unavailable, per call', async () => {
    stub = startStubNotebook()
    const client = clientFor(stub)
    await client.listNotebooks({})
    await stub.stop()
    const error = await client.listNotebooks({}).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(NotebookUnavailableError)
    expect((error as Error).message).not.toContain('127.0.0.1')
    stub = undefined
  })

  test('a notebook that answers too slowly is reported as unavailable', async () => {
    const slow = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Promise<Response>(() => {}) })
    try {
      const client = new NotebookClient({ url: `http://127.0.0.1:${slow.port}`, apiKey: undefined }, { timeoutMs: 50 })
      const error = await client.listNotebooks({}).catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(NotebookUnavailableError)
      expect((error as Error).message).toContain('did not answer')
    } finally {
      await slow.stop(true)
    }
  })

  test('a body that stalls after the headers is a timeout, not a shape error', async () => {
    const stalled = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () =>
        new Response(new ReadableStream({ start: (controller) => controller.enqueue(new TextEncoder().encode('[')) }), {
          headers: { 'Content-Type': 'application/json' },
        }),
    })
    try {
      const client = new NotebookClient({ url: `http://127.0.0.1:${stalled.port}`, apiKey: undefined }, { timeoutMs: 100 })
      const error = await client.listNotebooks({}).catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(NotebookUnavailableError)
      expect((error as Error).message).toContain('did not answer')
    } finally {
      await stalled.stop(true)
    }
  })

  test('a 4xx never repeats the notebook\'s own detail text', async () => {
    stub = startStubNotebook()
    const error = await clientFor(stub)
      .addTextSource({ title: 't', content: 'c', notebookIds: ['notebook:missing'], embed: false })
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(NotebookRequestError)
    expect((error as Error).message).toBe('the notebook refused the request (404); check the ids and values sent')
  })

  test('null counts and dates from the notebook are accepted', async () => {
    const nulls = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => Response.json([{ id: 'notebook:a', name: 'A', description: null, archived: null, updated: null, source_count: null, note_count: null }]),
    })
    try {
      const client = new NotebookClient({ url: `http://127.0.0.1:${nulls.port}`, apiKey: undefined })
      expect(await client.listNotebooks({})).toEqual([
        { id: 'notebook:a', name: 'A', description: '', archived: false, sourceCount: 0, noteCount: 0, updated: null },
      ])
    } finally {
      await nulls.stop(true)
    }
  })

  test('an answer in a shape the client does not know is reported, not passed on', async () => {
    const odd = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => Response.json({ unexpected: true }) })
    try {
      const client = new NotebookClient({ url: `http://127.0.0.1:${odd.port}`, apiKey: undefined })
      await expect(client.listNotebooks({})).rejects.toBeInstanceOf(NotebookUnavailableError)
    } finally {
      await odd.stop(true)
    }
  })

  test('an id goes into the path encoded, so it cannot reach another route', async () => {
    stub = startStubNotebook()
    await clientFor(stub).getSource('source:a b').catch(() => undefined)
    expect(stub.requests.at(-1)?.path).toBe('/api/sources/source%3Aa%20b')
  })
})

describe('probeNotebook', () => {
  test('a reachable notebook that takes the key is on', async () => {
    stub = startStubNotebook({ password: 'pw' })
    expect(await probeNotebook(clientFor(stub, 'pw'))).toEqual({ ok: true })
  })

  test('a wrong key is off, with the reason', async () => {
    stub = startStubNotebook({ password: 'pw' })
    const result = await probeNotebook(clientFor(stub, 'nope'))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('OPEN_NOTEBOOK_API_KEY')
  })

  test('an unreachable notebook is off, with the reason', async () => {
    stub = startStubNotebook()
    const client = clientFor(stub)
    await stub.stop()
    stub = undefined
    const result = await probeNotebook(client)
    expect(result.ok).toBe(false)
  })
})
