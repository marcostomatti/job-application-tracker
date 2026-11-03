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

import { generateApiKey } from '../../src/auth/api-key.ts'
import type { SpawnRequest, Spawner } from '../../src/backup/dump.ts'
import type { BackupTimers } from '../../src/backup/schedule.ts'
import { setBackupSettings } from '../../src/data/repositories/config.ts'
import { withMigratedScratchDatabase } from '../data/scratch-database.ts'
import { closeDb, getDb } from '../../src/data/client.ts'
import { ROUTES } from '../../src/http/routes/index.ts'
import { backupOptionsFor, startService } from '../../src/http/server.ts'

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
  ])('with API_KEY %s, refuses to start before the database or any listener is touched', async (_label, value) => {
    restore('API_KEY', value)
    // With the database unreachable, a key check that ran after the pool started would surface
    // the database failure instead of the key's, so the message tells the two orders apart.
    process.env.DATABASE_URL = `postgres://tracker:unused@localhost:${await unusedPort()}/tracker`
    await closeDb()
    const listen = spyOn(express.application, 'listen')

    try {
      const failure = await startService().catch((error: unknown) => error)

      expect(failure).toBeInstanceOf(Error)
      expect((failure as Error).message).toMatch(/API_KEY/)
      expect((failure as Error).message).not.toMatch(/database/i)
      expect(listen).not.toHaveBeenCalled()
    } finally {
      listen.mockRestore()
    }
    expect(typeof express.application.listen).toBe('function')
  })

  test('the refusal names the fix', async () => {
    restore('API_KEY', undefined)

    const failure = await startService().catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain('setApiKey')
  })

  test.each([0, 70_000, 80.5, Number.NaN])('refuses a port option of %s before opening anything', async (port) => {
    await expect(startService({ port })).rejects.toThrow(/port option/)
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

  describe('what the service logs', () => {
    /** A made-up key and a made-up wrong token, built at run time so no key-shaped literal is committed. */
    const LOG_KEY = 'log-probe-key-'.concat('k'.repeat(40))
    const WRONG_TOKEN = 'log-probe-wrong-'.concat('w'.repeat(40))

    /** Runs the probe fixture with the given key and returns everything it wrote, parsed one JSON line at a time. */
    async function probe(apiKey: string): Promise<{ readonly raw: string; readonly entries: readonly Record<string, unknown>[] }> {
      const child = Bun.spawn(['bun', join(import.meta.dir, 'fixtures/probe-service.ts')], {
        env: { ...process.env, API_KEY: apiKey, PROBE_WRONG_TOKEN: WRONG_TOKEN, NODE_ENV: 'test' },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(code).toBe(0)
      const raw = `${out}\n${err}`
      const entries = raw
        .split('\n')
        .filter((line) => line.startsWith('{'))
        .map((line) => JSON.parse(line) as Record<string, unknown>)
      return { raw, entries }
    }

    test('no log line carries the key or a presented token while an authorized and an unauthorized request are served', async () => {
      const { raw, entries } = await probe(LOG_KEY)

      expect(entries.length).toBeGreaterThan(0)
      expect(entries.some((entry) => entry.msg === 'request completed')).toBe(true)
      expect(raw).not.toContain(LOG_KEY)
      expect(raw).not.toContain(WRONG_TOKEN)
    }, 30_000)

    test('a key shorter than a generated one starts the service and warns, naming neither key nor length', async () => {
      const shortKey = 'short-probe-key'

      const { raw, entries } = await probe(shortKey)

      const warnings = entries.filter((entry) => entry.level === 40)
      expect(warnings).toHaveLength(1)
      const extras = Object.keys(warnings[0] ?? {}).filter(
        (name) => !['level', 'time', 'pid', 'hostname', 'service', 'msg'].includes(name),
      )
      expect(extras).toEqual([])
      expect(String(warnings[0]?.msg)).toMatch(/shorter/)
      expect(String(warnings[0]?.msg)).not.toMatch(/\d/)
      expect(raw).not.toContain(shortKey)
    }, 30_000)

    test('a key as long as a generated one draws no warning', async () => {
      const { entries } = await probe(generateApiKey())

      expect(entries.filter((entry) => entry.level === 40)).toEqual([])
    }, 30_000)
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

  describe('the backup schedule', () => {
    const silent = { info: () => {}, warn: () => {}, error: () => {} }
    /** A made-up connection for a stand-in that never connects. */
    const FAKE_URL = 'postgres://backup_user:s3cret@db.example.test:5433/tracker_db'
    let backupDir: string | undefined

    afterEach(async () => {
      if (backupDir) await rm(backupDir, { recursive: true, force: true })
      backupDir = undefined
    })

    /** Waits, up to a few seconds, for a condition a background task will bring about. */
    async function until(condition: () => boolean): Promise<void> {
      const deadline = Date.now() + 5_000
      while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
      expect(condition()).toBe(true)
    }

    test('is not started under NODE_ENV=test unless a test passes its own', () => {
      const own = { outDir: '/somewhere' }

      expect(backupOptionsFor({ NODE_ENV: 'test' }, undefined)).toBeUndefined()
      expect(backupOptionsFor({ NODE_ENV: 'production' }, undefined)).toEqual({})
      expect(backupOptionsFor({}, undefined)).toEqual({})
      expect(backupOptionsFor({ NODE_ENV: 'test' }, own)).toBe(own)
    })

    test('does not hold the service back while a due dump runs, and stop() clears its timer', async () => {
      await withMigratedScratchDatabase(async (scratch) => {
        // Arrange: a stand-in whose dump does not finish until the test says so
        backupDir = await mkdtemp(join(tmpdir(), 'service-backups-'))
        const calls: SpawnRequest[] = []
        let release: () => void = () => {}
        const gate = new Promise<void>((resolve) => {
          release = resolve
        })
        const spawn: Spawner = async (request) => {
          calls.push(request)
          await gate
          const target = request.args.find((arg) => arg.startsWith('--file='))?.slice('--file='.length) ?? ''
          await writeFile(target, 'a dump')
          return { exitCode: 0, signal: null, stderr: '' }
        }
        const cleared: unknown[] = []
        const timers: BackupTimers = { setInterval: () => 'timer', clearInterval: (handle) => void cleared.push(handle) }

        try {
          // Act: startService resolves although the first check is waiting on the gate
          const { origin } = await start({ backup: { db: scratch, outDir: backupDir, spawn, timers, databaseUrl: FAKE_URL, logger: silent } })
          await until(() => calls.length === 1)
          const health = await fetch(`${origin}/health`)

          // Assert: the dump is still in flight and the service already answers
          expect(health.status).toBe(200)
          expect(cleared).toEqual([])
        } finally {
          release()
        }
        await stopRunning()
        expect(cleared).toEqual(['timer'])
      })
    })

    test('reads its settings from the database it is given, so a local app_config cannot change the test', async () => {
      await withMigratedScratchDatabase(async (scratch) => {
        await setBackupSettings(scratch, { enabled: false })
        const calls: SpawnRequest[] = []
        const spawn: Spawner = async (request) => {
          calls.push(request)
          return { exitCode: 1, signal: null, stderr: '' }
        }
        const started: unknown[] = []
        const timers: BackupTimers = { setInterval: () => void started.push(1), clearInterval: () => {} }

        await start({ backup: { db: scratch, outDir: tmpdir(), spawn, timers, databaseUrl: FAKE_URL, logger: silent } })
        await stopRunning()

        expect(started).toEqual([])
        expect(calls).toEqual([])
      })
    })

    test('a schedule that cannot start is logged by name and does not stop the service', async () => {
      await withMigratedScratchDatabase(async (scratch) => {
        const logged: string[] = []
        const logger = { ...silent, error: (context: object, message: string) => void logged.push(JSON.stringify([context, message])) }
        const timers: BackupTimers = {
          setInterval: () => {
            throw new TypeError('timer refused for postgres://u:leaky@h/d')
          },
          clearInterval: () => {},
        }

        const { origin } = await start({ backup: { db: scratch, outDir: tmpdir(), timers, logger } })
        const health = await fetch(`${origin}/health`)

        expect(health.status).toBe(200)
        await until(() => logged.length > 0)
        expect(logged.join('\n')).not.toContain('leaky')
      })
    })
  })
})
