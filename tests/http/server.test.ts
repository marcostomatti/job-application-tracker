import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createServer } from 'node:net'

import { GENERATED_KEY_LENGTH } from '../../src/auth/api-key.ts'
import { closeDb } from '../../src/data/client.ts'
import { backupOptionsFor, startService } from '../../src/http/server.ts'

/**
 * A key made up for these tests; it matches nothing real. It is as long as a generated one, so
 * starting the service with it does not draw the short-key warning and add noise to every run.
 */
const TEST_KEY = 'test-key-for-the-server-entry-'.padEnd(GENERATED_KEY_LENGTH, 'k')

const savedEnv = { apiKey: process.env.API_KEY, databaseUrl: process.env.DATABASE_URL, logLevel: process.env.LOG_LEVEL }

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
    // The chassis listens through a node:http server, so a spy on its prototype sees any listen.
    const listen = spyOn(http.Server.prototype, 'listen')

    try {
      const failure = await startService().catch((error: unknown) => error)

      expect(failure).toBeInstanceOf(Error)
      expect((failure as Error).message).toMatch(/API_KEY/)
      expect((failure as Error).message).not.toMatch(/database/i)
      expect(listen).not.toHaveBeenCalled()
    } finally {
      listen.mockRestore()
    }
    expect(typeof http.Server.prototype.listen).toBe('function')
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

  describe('the backup schedule', () => {
    test('is not started under NODE_ENV=test unless a test passes its own', () => {
      const own = { outDir: '/somewhere' }

      expect(backupOptionsFor({ NODE_ENV: 'test' }, undefined)).toBeUndefined()
      expect(backupOptionsFor({ NODE_ENV: 'production' }, undefined)).toEqual({})
      expect(backupOptionsFor({}, undefined)).toEqual({})
      expect(backupOptionsFor({ NODE_ENV: 'test' }, own)).toBe(own)
    })
  })
})
