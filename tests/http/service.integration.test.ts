/**
 * The assembled service, run as its own process: the chassis, the key on `/api`, the routes and
 * the web bundle, answering real requests. Each service runs in a child process so that what it
 * logs, the chassis's request log included, is read here and asserted on, and never printed.
 * The route table and `jsonHandler` are tested on their own in `routes.test.ts` and
 * `handler.test.ts`; what needs the service in this process (its start refusals, `stop()` and
 * the backup wiring) is in `server.test.ts`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { GENERATED_KEY_LENGTH, generateApiKey } from '../../src/auth/api-key.ts'
import { ROUTES } from '../../src/http/routes/index.ts'
import { spawnRefusedService, spawnService, stopStrayServices, type LogEntry, type ServiceProcess } from './service-process.ts'

/**
 * A key made up for these tests; it matches nothing real. It is as long as a generated one, so
 * the service does not draw the short-key warning.
 */
const TEST_KEY = 'test-key-for-the-server-entry-'.padEnd(GENERATED_KEY_LENGTH, 'k')

/** A bundle directory that does not exist, so a bundle built later in `src/web/dist` cannot change these tests. */
const NO_BUNDLE = join(tmpdir(), 'no-such-bundle-directory')

/** Requests sent in one burst, well past the chassis default of 100 a minute. */
const BURST = 150

/** Starting a process of its own takes longer than the default five seconds allow under load. */
const PROCESS_TIMEOUT = 30_000

const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` })

/** The status of every request the service logged as completed, in order. */
const completedStatuses = (entries: readonly LogEntry[]): number[] =>
  entries.filter((entry) => entry.msg === 'request completed').map((entry) => (entry.res as { statusCode: number }).statusCode)

/** A port nothing is listening on: one is opened to get a number, then closed. */
async function unusedPort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((ready) => probe.listen(0, () => ready()))
  const port = (probe.address() as AddressInfo).port
  await new Promise<void>((done) => probe.close(() => done()))
  return port
}

// After the file, not after each test: the first group shares one service across its tests.
afterAll(async () => {
  await stopStrayServices()
}, PROCESS_TIMEOUT)

describe('the service with a key and no web bundle', () => {
  let service: ServiceProcess | undefined
  let origin: string

  beforeAll(async () => {
    const started = await spawnService({ API_KEY: TEST_KEY, FIXTURE_WEB_DIST: NO_BUNDLE })
    service = started
    origin = started.origin
  }, PROCESS_TIMEOUT)

  afterAll(async () => {
    // Unset when the start failed; that failure is the one to report, and the stray is killed below.
    if (service === undefined) return
    const output = await service.stop()
    expect(output.code).toBe(0)
  }, PROCESS_TIMEOUT)

  test('answers GET /health from the chassis', async () => {
    const response = await fetch(`${origin}/health`)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'ok' })
  })

  test('/api without a bearer token answers 401', async () => {
    const response = await fetch(`${origin}/api/positions`)

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({
      success: false,
      error: { name: 'Unauthorized', message: 'a valid API key is required' },
    })
  })

  test('the 401 and a route failure share one envelope, so body.error.message reads on both', async () => {
    const refused = await fetch(`${origin}/api/positions`)
    const missing = await fetch(`${origin}/api/positions/2147483647`, { headers: bearer(TEST_KEY) })

    expect(refused.status).toBe(401)
    expect(missing.status).toBe(404)
    for (const response of [refused, missing]) {
      const body = (await response.json()) as { success: unknown; error: { name: unknown; message: unknown } }
      expect(body.success).toBe(false)
      expect(typeof body.error.name).toBe('string')
      expect(typeof body.error.message).toBe('string')
    }
  })

  test('a body that is not JSON is answered by the chassis with a string error, the case the README documents as outside the envelope', async () => {
    const response = await fetch(`${origin}/api/positions`, {
      method: 'POST',
      headers: { ...bearer(TEST_KEY), 'content-type': 'application/json' },
      body: '{not json',
    })

    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: unknown }
    expect(typeof body.error).toBe('string')
  })

  test('/api with a wrong token answers 401', async () => {
    const response = await fetch(`${origin}/api/positions`, { headers: bearer('not-the-key') })

    expect(response.status).toBe(401)
  })

  test('/api with the right token answers 200', async () => {
    const response = await fetch(`${origin}/api/positions`, { headers: bearer(TEST_KEY) })

    expect(response.status).toBe(200)
    const body = (await response.json()) as { success: boolean; data: unknown }
    expect(body.success).toBe(true)
    expect(Array.isArray(body.data)).toBe(true)
  })

  test('no route in the table is reachable without the token', async () => {
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

  test('does not rate-limit a burst a web board could send', async () => {
    const responses = await Promise.all(
      Array.from({ length: BURST }, () => fetch(`${origin}/api/positions`, { headers: bearer(TEST_KEY) })),
    )

    expect(responses.filter((response) => response.status === 429)).toHaveLength(0)
  })

  test('the static mount is skipped when the web bundle is absent', async () => {
    const page = await fetch(`${origin}/index.html`)
    const health = await fetch(`${origin}/health`)

    expect(page.status).toBe(404)
    expect(health.status).toBe(200)
  })
})

describe('the service with a web bundle', () => {
  let bundle: string | undefined

  afterEach(async () => {
    if (bundle) await rm(bundle, { recursive: true, force: true })
    bundle = undefined
  })

  test('serves the bundle from the same origin, and /api stays behind the key', async () => {
    bundle = await mkdtemp(join(tmpdir(), 'web-dist-'))
    await writeFile(join(bundle, 'index.html'), '<title>tracker</title>')
    const service = await spawnService({ API_KEY: TEST_KEY, FIXTURE_WEB_DIST: bundle })

    const page = await fetch(`${service.origin}/index.html`)
    const api = await fetch(`${service.origin}/api/positions`)
    const output = await service.stop()

    expect(page.status).toBe(200)
    expect(await page.text()).toContain('<title>tracker</title>')
    expect(api.status).toBe(401)
    expect(output.code).toBe(0)
  }, PROCESS_TIMEOUT)
})

describe('what the service logs', () => {
  /** A made-up key and a made-up wrong token, built at run time so no key-shaped literal is committed. */
  const LOG_KEY = 'log-probe-key-'.concat('k'.repeat(40))
  const WRONG_TOKEN = 'log-probe-wrong-'.concat('w'.repeat(40))

  test('no log line carries the key or a presented token while an authorized and an unauthorized request are served', async () => {
    const service = await spawnService({ API_KEY: LOG_KEY, FIXTURE_WEB_DIST: NO_BUNDLE })

    await fetch(`${service.origin}/api/positions`, { headers: bearer(LOG_KEY) }).then((response) => response.text())
    await fetch(`${service.origin}/api/positions`).then((response) => response.text())
    await fetch(`${service.origin}/api/positions`, { headers: bearer(WRONG_TOKEN) }).then((response) => response.text())
    const { code, raw, entries } = await service.stop()

    expect(code).toBe(0)
    // Every request logs a "request completed" line, so the 401s alone could satisfy a looser
    // check. The 200 is what shows the authorized request was served.
    expect(completedStatuses(entries).sort()).toEqual([200, 401, 401])
    expect(raw).not.toContain(LOG_KEY)
    expect(raw).not.toContain(WRONG_TOKEN)
  }, PROCESS_TIMEOUT)

  test('a key shorter than a generated one starts the service and warns, naming neither key nor length', async () => {
    const shortKey = 'short-probe-key'
    const service = await spawnService({ API_KEY: shortKey, FIXTURE_WEB_DIST: NO_BUNDLE })

    const { code, raw, entries } = await service.stop()

    expect(code).toBe(0)
    const warnings = entries.filter((entry) => entry.level === 40)
    expect(warnings).toHaveLength(1)
    const extras = Object.keys(warnings[0] ?? {}).filter(
      (name) => !['level', 'time', 'pid', 'hostname', 'service', 'msg'].includes(name),
    )
    expect(extras).toEqual([])
    expect(String(warnings[0]?.msg)).toMatch(/shorter/)
    expect(String(warnings[0]?.msg)).not.toMatch(/\d/)
    expect(raw).not.toContain(shortKey)
  }, PROCESS_TIMEOUT)

  test('a key as long as a generated one draws no warning', async () => {
    const service = await spawnService({ API_KEY: generateApiKey(), FIXTURE_WEB_DIST: NO_BUNDLE })

    const { code, entries } = await service.stop()

    expect(code).toBe(0)
    expect(entries.filter((entry) => entry.level === 40)).toEqual([])
  }, PROCESS_TIMEOUT)

  test('an unreachable database is refused, not exited on, and neither the refusal nor the log names its address', async () => {
    const password = 'not-a-real-password'
    const port = await unusedPort()

    const refused = await spawnRefusedService({
      API_KEY: TEST_KEY,
      DATABASE_URL: `postgres://tracker:${password}@localhost:${port}/tracker`,
    })

    // A process the chassis exited would write no refusal line, so `message` would be undefined.
    expect(refused.message).toBeString()
    expect(refused.message).not.toContain(password)
    expect(refused.message).not.toContain('postgres://')
    expect(refused.entries.some((entry) => entry.msg === 'database unreachable')).toBe(true)
    expect(refused.raw).not.toContain(password)
    expect(refused.raw).not.toContain(`localhost:${port}`)
  }, PROCESS_TIMEOUT)
})
