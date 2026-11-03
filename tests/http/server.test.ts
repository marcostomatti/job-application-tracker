import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import express from 'express'
import { sql } from 'drizzle-orm'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ServiceHandle } from '@open-tomato/service-express'

import { closeDb, getDb } from '../../src/data/client.ts'
import { ROUTES } from '../../src/http/routes/index.ts'
import { startService } from '../../src/http/server.ts'

/** A key made up for these tests; it matches nothing real. */
const TEST_KEY = 'test-key-for-the-server-entry'

/** Requests sent in one burst, well past the chassis default of 100 a minute. */
const BURST = 150

type Running = {
  readonly handle: ServiceHandle
  readonly outer: Server
  readonly origin: string
  /** Every server `app.listen` created while the service started: the chassis's own is the first. */
  readonly chassisServers: readonly Server[]
}

const savedEnv = { apiKey: process.env.API_KEY, databaseUrl: process.env.DATABASE_URL }
let running: Running | undefined

/**
 * Starts the service and listens on a second, known port. `createService` binds an ephemeral
 * port under `NODE_ENV=test` but its handle never says which, so the same app is listened on
 * again here, as the harness does. The `listen` spy collects the chassis's own server so a test
 * can see it close.
 */
async function start(opts?: Parameters<typeof startService>[0]): Promise<Running> {
  if (process.env.NODE_ENV !== 'test') throw new Error('these tests need NODE_ENV=test')
  const chassisServers: Server[] = []
  const original = express.application.listen
  // Patched by hand and not with spyOn: express copies `listen` onto each app it makes, so the
  // copy outlives the patch and a spy's restore would reset the very function the app holds.
  express.application.listen = function (this: unknown, ...args: unknown[]): Server {
    const server = (original as (...a: unknown[]) => Server).apply(this, args)
    chassisServers.push(server)
    return server
  } as typeof original
  let handle: ServiceHandle
  try {
    handle = await startService(opts)
  } finally {
    express.application.listen = original
  }
  const outer = await new Promise<Server>((ready, failed) => {
    const server = handle.app.listen(0, () => ready(server))
    server.once('error', failed)
  })
  const origin = `http://localhost:${(outer.address() as AddressInfo).port}`
  running = { handle, outer, origin, chassisServers }
  return running
}

async function stopRunning(): Promise<void> {
  const current = running
  running = undefined
  if (!current) return
  current.outer.closeAllConnections()
  await new Promise<void>((done) => current.outer.close(() => done()))
  await current.handle.stop()
}

/** A port nothing is listening on: one is opened to get a number, then closed. */
async function unusedPort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((ready) => probe.listen(0, () => ready()))
  const port = (probe.address() as AddressInfo).port
  await new Promise<void>((done) => probe.close(() => done()))
  return port
}

beforeEach(() => {
  process.env.API_KEY = TEST_KEY
})

afterEach(async () => {
  await stopRunning()
  await closeDb()
  restore('API_KEY', savedEnv.apiKey)
  restore('DATABASE_URL', savedEnv.databaseUrl)
})

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` })

describe('startService', () => {
  test('answers GET /health from the chassis', async () => {
    const { origin } = await start()

    const response = await fetch(`${origin}/health`)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'ok' })
  })

  test('with API_KEY set, /api without a bearer token answers 401', async () => {
    const { origin } = await start()

    const response = await fetch(`${origin}/api/positions`)

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'unauthorized' })
  })

  test('with API_KEY set, /api with a wrong token answers 401', async () => {
    const { origin } = await start()

    const response = await fetch(`${origin}/api/positions`, { headers: bearer('not-the-key') })

    expect(response.status).toBe(401)
  })

  test('with API_KEY set, /api with the right token answers 200', async () => {
    const { origin } = await start()

    const response = await fetch(`${origin}/api/positions`, { headers: bearer(TEST_KEY) })

    expect(response.status).toBe(200)
    const body = (await response.json()) as { success: boolean; data: unknown }
    expect(body.success).toBe(true)
    expect(Array.isArray(body.data)).toBe(true)
  })

  test('with API_KEY set, no route in the table is reachable without the token', async () => {
    const { origin } = await start()

    const outcomes = await Promise.all(
      ROUTES.map(async (spec) => {
        const path = spec.path.replace(/:\w+/g, '1')
        const response = await fetch(`${origin}/api${path}`, {
          method: spec.method.toUpperCase(),
          headers: { 'content-type': 'application/json' },
          ...(spec.method === 'get' ? {} : { body: '{}' }),
        })
        return { route: `${spec.method} ${spec.path}`, status: response.status }
      }),
    )

    expect(outcomes.filter((outcome) => outcome.status !== 401)).toEqual([])
    expect(outcomes.length).toBe(ROUTES.length)
  })

  test.each([
    ['unset', undefined],
    ['empty', ''],
  ])('with API_KEY %s, refuses to start and opens nothing', async (_label, value) => {
    restore('API_KEY', value)
    const listen = spyOn(express.application, 'listen')

    try {
      await expect(startService()).rejects.toThrow(/API_KEY/)
      expect(listen).not.toHaveBeenCalled()
    } finally {
      listen.mockRestore()
    }
    expect(typeof express.application.listen).toBe('function')
  })

  test('the refusal names the fix and does not echo any key', async () => {
    restore('API_KEY', undefined)

    const failure = await startService().catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain('setApiKey')
  })

  test.each(['abc', '0', '70000', '80.5'])('refuses a PORT of %s before opening anything', async (value) => {
    const saved = process.env.PORT
    process.env.PORT = value

    try {
      await expect(startService()).rejects.toThrow(/PORT/)
    } finally {
      restore('PORT', saved)
    }
  })

  test('does not rate-limit a burst a web board could send', async () => {
    const { origin } = await start()

    const responses = await Promise.all(
      Array.from({ length: BURST }, () => fetch(`${origin}/api/positions`, { headers: bearer(TEST_KEY) })),
    )

    expect(responses.filter((response) => response.status === 429)).toHaveLength(0)
  })

  test('stop() closes the server and the pool', async () => {
    const { handle, outer, chassisServers } = await start()
    const db = getDb()
    await db.execute(sql`select 1`)
    expect(chassisServers[0]?.listening).toBe(true)

    outer.closeAllConnections()
    await new Promise<void>((done) => outer.close(() => done()))
    await handle.stop()
    running = undefined

    expect(chassisServers[0]?.listening).toBe(false)
    const afterStop = (async () => db.execute(sql`select 1`))()
    await expect(afterStop).rejects.toThrow()
  })

  test('rejects, rather than exiting, when the database is unreachable, and says nothing of its address', async () => {
    const password = 'not-a-real-password'
    process.env.DATABASE_URL = `postgres://tracker:${password}@localhost:${await unusedPort()}/tracker`
    await closeDb()

    const failure = await startService().catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(Error)
    expect(String((failure as Error).message)).not.toContain(password)
    expect(String((failure as Error).message)).not.toContain('postgres://')
  })

  describe('the web bundle', () => {
    let bundle: string | undefined

    afterEach(async () => {
      if (bundle) await rm(bundle, { recursive: true, force: true })
      bundle = undefined
    })

    test('the static mount is skipped when the web bundle is absent', async () => {
      const { origin } = await start({ webDist: join(tmpdir(), 'no-such-bundle-directory') })

      const page = await fetch(`${origin}/index.html`)
      const health = await fetch(`${origin}/health`)

      expect(page.status).toBe(404)
      expect(health.status).toBe(200)
    })

    test('the bundle is served from the same origin when it exists, and /api stays behind the key', async () => {
      bundle = await mkdtemp(join(tmpdir(), 'web-dist-'))
      await writeFile(join(bundle, 'index.html'), '<title>tracker</title>')
      const { origin } = await start({ webDist: bundle })

      const page = await fetch(`${origin}/index.html`)
      const api = await fetch(`${origin}/api/positions`)

      expect(page.status).toBe(200)
      expect(await page.text()).toContain('<title>tracker</title>')
      expect(api.status).toBe(401)
    })
  })
})
