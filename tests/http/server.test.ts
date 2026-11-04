import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import express from 'express'
import { sql } from 'drizzle-orm'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ServiceHandle } from '@open-tomato/service-express'

import { GENERATED_KEY_LENGTH } from '../../src/auth/api-key.ts'
import type { SpawnRequest, Spawner } from '../../src/backup/dump.ts'
import type { BackupTimers } from '../../src/backup/schedule.ts'
import { setBackupSettings } from '../../src/data/repositories/config.ts'
import { withMigratedScratchDatabase } from '../data/scratch-database.ts'
import { countingDb } from '../backup/db-proxies.ts'
import { closeDb, getDb } from '../../src/data/client.ts'
import { backupOptionsFor, startService } from '../../src/http/server.ts'

/**
 * A key made up for these tests; it matches nothing real. It is as long as a generated one, so
 * starting the service with it does not draw the short-key warning and add noise to every run.
 */
const TEST_KEY = 'test-key-for-the-server-entry-'.padEnd(GENERATED_KEY_LENGTH, 'k')

type Running = {
  readonly handle: ServiceHandle
  /** Every server `app.listen` created while the service started: the chassis's own is the first. */
  readonly chassisServers: readonly Server[]
}

const savedEnv = { apiKey: process.env.API_KEY, databaseUrl: process.env.DATABASE_URL, logLevel: process.env.LOG_LEVEL }
let running: Running | undefined

/**
 * Starts the service in this process. The patched `listen` collects the chassis's own server, so
 * a test can see it listen and close. No request is sent: a request is answered and logged by
 * the chassis's request logger, which has no level setting, so every test that sends one runs
 * the service in a process of its own, in `service.integration.test.ts`.
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
  running = { handle, chassisServers }
  return running
}

async function stopRunning(): Promise<void> {
  const current = running
  running = undefined
  if (!current) return
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

// The chassis's service logger reads LOG_LEVEL when it is made, at each start. Nothing here
// reads what it writes, and what the service logs is asserted in service.integration.test.ts.
beforeAll(() => {
  process.env.LOG_LEVEL = 'silent'
})

afterAll(() => {
  restore('LOG_LEVEL', savedEnv.logLevel)
})

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

describe('startService', () => {
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

  test('stop() closes the server and the pool', async () => {
    const { handle, chassisServers } = await start()
    const db = getDb()
    await db.execute(sql`select 1`)
    expect(chassisServers[0]?.listening).toBe(true)

    await handle.stop()
    running = undefined

    expect(chassisServers[0]?.listening).toBe(false)
    const afterStop = (async () => db.execute(sql`select 1`))()
    await expect(afterStop).rejects.toThrow()
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
          const { chassisServers } = await start({ backup: { db: scratch, outDir: backupDir, spawn, timers, databaseUrl: FAKE_URL, logger: silent } })
          await until(() => calls.length === 1)

          // Assert: the dump is still in flight and the service already listens
          expect(chassisServers[0]?.listening).toBe(true)
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
        const counted = countingDb(scratch)
        const calls: SpawnRequest[] = []
        const spawn: Spawner = async (request) => {
          calls.push(request)
          return { exitCode: 1, signal: null, stderr: '' }
        }
        const started: unknown[] = []
        const timers: BackupTimers = { setInterval: () => void started.push(1), clearInterval: () => {} }
        const selectsBefore = counted.selects()

        await start({ backup: { db: counted.db, outDir: tmpdir(), spawn, timers, databaseUrl: FAKE_URL, logger: silent } })
        await stopRunning()

        // The scratch database was read (this fails if the override is dropped, whatever the shared
        // database says), and what it said, backups off, is what the schedule did
        expect(counted.selects()).toBeGreaterThan(selectsBefore)
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

        const { chassisServers } = await start({ backup: { db: scratch, outDir: tmpdir(), timers, logger } })

        expect(chassisServers[0]?.listening).toBe(true)
        await until(() => logged.length > 0)
        expect(logged.join('\n')).not.toContain('leaky')
      })
    })
  })
})
