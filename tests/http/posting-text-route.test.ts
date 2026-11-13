import { afterEach, describe, expect, test } from 'bun:test'
import express from 'express'
import type { Server } from 'node:http'

import type { Db } from '../../src/data/repositories/db.ts'
import { NotFoundError } from '../../src/errors.ts'
import { mountRoutes } from '../../src/http/routes/index.ts'
import { postingTextRoutes } from '../../src/http/routes/posting-text.ts'
import { NotebookClient } from '../../src/notebook/client.ts'
import { startStubNotebook, type StubServer } from '../notebook/stub-server.ts'

/** The one tracker read the route makes, without a database: posting 1 is known. */
async function keyOf(_db: Db, postingId: number): Promise<string> {
  if (postingId !== 1) throw new NotFoundError('posting', postingId)
  return 'example-ab/backend-engineer'
}

/** A database the route must never touch: every property read throws. */
const untouchable = new Proxy({}, { get: () => { throw new Error('the route touched the database') } }) as Db

let server: Server | undefined
let stub: StubServer | undefined

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  server = undefined
  await stub?.stop()
  stub = undefined
})

async function serve(client: NotebookClient | undefined): Promise<string> {
  const app = express()
  mountRoutes(app, untouchable, postingTextRoutes(client, keyOf))
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening))
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return `http://127.0.0.1:${address.port}`
}

describe('GET /api/postings/:postingId/notebook-text', () => {
  test('without a notebook it answers that none is configured', async () => {
    const base = await serve(undefined)

    const response = await fetch(`${base}/api/postings/1/notebook-text`)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ success: true, data: { configured: false } })
  })

  test("with a notebook it returns the posting's stored text", async () => {
    stub = startStubNotebook({ password: 'pw' })
    const client = new NotebookClient({ url: stub.url, apiKey: 'pw' })
    const notebook = await client.createNotebook({ name: 'Postings', description: '' })
    await client.addTextSource({ title: 'example-ab/backend-engineer', content: 'the full posting', notebookIds: [notebook.id], embed: false })
    const base = await serve(client)

    const body = (await (await fetch(`${base}/api/postings/1/notebook-text`)).json()) as { data: { text: string; copies: number } }

    expect(body.data).toMatchObject({ text: 'the full posting', copies: 1 })
  })

  test('an unknown posting is a 404, and a notebook that is down is a 503', async () => {
    stub = startStubNotebook({ password: 'pw' })
    const client = new NotebookClient({ url: stub.url, apiKey: 'pw' })
    const base = await serve(client)

    expect((await fetch(`${base}/api/postings/99/notebook-text`)).status).toBe(404)
    await stub.stop()
    stub = undefined
    expect((await fetch(`${base}/api/postings/1/notebook-text`)).status).toBe(503)
  })
})
