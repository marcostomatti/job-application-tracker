import { describe, expect, test } from 'bun:test'
import type { Request, Response } from 'express'

import { requireApiKey, type AuthLog } from '../../src/auth/middleware.ts'

/** A stand-in secret built at run time, so no key-shaped literal sits in the repository. */
const EXPECTED = 'stand-in-secret-'.concat('b'.repeat(24))

type Outcome = {
  readonly nextCalls: number
  readonly status: number | undefined
  readonly body: unknown
  readonly headers: Readonly<Record<string, string>>
  readonly logged: readonly { readonly context: object; readonly message: string }[]
}

/**
 * Drives the handler with a minimal request, response and `next`, and records what it did.
 * `authorization` is the raw header value as Node would hand it over, or absent when `undefined`.
 */
async function run(expected: string | undefined, authorization: unknown): Promise<Outcome> {
  let nextCalls = 0
  let status: number | undefined
  let body: unknown
  const headers: Record<string, string> = {}
  const logged: { context: object; message: string }[] = []
  const log: AuthLog = { error: (context, message) => void logged.push({ context, message }) }

  const req = { headers: authorization === undefined ? {} : { authorization } } as unknown as Request
  const res = {
    set(name: string, value: string) {
      headers[name] = value
      return res
    },
    status(code: number) {
      status = code
      return res
    },
    json(payload: unknown) {
      body = payload
      return res
    },
  } as unknown as Response

  await requireApiKey(expected, log)(req, res, () => void (nextCalls += 1))
  return { nextCalls, status, body, headers, logged }
}

describe('requireApiKey with no key configured', () => {
  test.each([
    ['undefined', undefined],
    ['an empty string', ''],
  ])('requireApiKey refuses every request when the key is %s', async (_name, expected) => {
    // Six distinct header values: absent, empty, scheme with an empty token, the right key,
    // the scheme alone, and a token that is the word "undefined".
    const authorizations = [undefined, '', 'Bearer ', `Bearer ${EXPECTED}`, 'Bearer', 'Bearer undefined']
    for (const authorization of authorizations) {
      const outcome = await run(expected, authorization)

      expect(outcome.status).toBe(503)
      expect(outcome.nextCalls).toBe(0)
    }
  })

  test('requireApiKey does not let an empty bearer token through an empty configured key', async () => {
    const outcome = await run('', 'Bearer ')

    expect(outcome.status).toBe(503)
    expect(outcome.nextCalls).toBe(0)
  })

  test('requireApiKey logs the reason once, when it is created, and not per request', async () => {
    const logged: { context: object; message: string }[] = []
    const log: AuthLog = { error: (context, message) => void logged.push({ context, message }) }

    // Act: creating the middleware, before any request exists.
    const handler = requireApiKey(undefined, log)

    // Assert: the reason is already logged.
    expect(logged).toHaveLength(1)
    expect(logged[0]?.message).toContain('API_KEY')

    // Act: three refused requests.
    const res = { status: () => res, json: () => res } as unknown as Response
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await handler({ headers: {} } as unknown as Request, res, () => undefined)
    }

    // Assert: still the one line.
    expect(logged).toHaveLength(1)
  })

  test('requireApiKey refuses with 503 using the module default logger when none is passed', async () => {
    // Arrange: the default logger is made on first use and reads LOG_LEVEL then, so the level
    // is silenced for this call to keep the test output clean. Only the response is asserted.
    const previous = process.env.LOG_LEVEL
    process.env.LOG_LEVEL = 'silent'
    let status: number | undefined
    let body: unknown
    let nextCalls = 0
    const res = {
      status(code: number) {
        status = code
        return res
      },
      json(payload: unknown) {
        body = payload
        return res
      },
    } as unknown as Response

    // Act: the default logger is made, and the reason logged, when the middleware is created.
    try {
      const handler = requireApiKey(undefined)
      await handler({ headers: {} } as unknown as Request, res, () => void (nextCalls += 1))
    } finally {
      if (previous === undefined) delete process.env.LOG_LEVEL
      else process.env.LOG_LEVEL = previous
    }

    // Assert
    expect(status).toBe(503)
    expect(body).toEqual({
      success: false,
      error: { name: 'Unavailable', message: 'the service is not configured to accept requests' },
    })
    expect(nextCalls).toBe(0)
  })

  test('the 503 body and its log line carry nothing about the presented token', async () => {
    const presented = 'presented-'.concat('c'.repeat(20))
    const outcome = await run(undefined, `Bearer ${presented}`)

    const everything = JSON.stringify([outcome.body, outcome.logged])
    expect(everything).not.toContain(presented)
    expect(everything).not.toContain(String(presented.length))
  })
})

describe('requireApiKey with a key configured', () => {
  test('requireApiKey passes a request carrying the right bearer token', async () => {
    const outcome = await run(EXPECTED, `Bearer ${EXPECTED}`)

    expect(outcome.nextCalls).toBe(1)
    expect(outcome.status).toBeUndefined()
  })

  test('requireApiKey answers 401 when the header is not a string', async () => {
    // Node hands over a string for this header, but the guard must not become a truthiness check.
    for (const authorization of [['x', 'y'], [`Bearer ${EXPECTED}`], 42, {}, null]) {
      const outcome = await run(EXPECTED, authorization)

      expect(outcome.status).toBe(401)
      expect(outcome.nextCalls).toBe(0)
    }
  })

  test('requireApiKey answers every 401 with a bare Bearer challenge', async () => {
    for (const authorization of [undefined, 'Bearer ', `Bearer ${EXPECTED}x`]) {
      const outcome = await run(EXPECTED, authorization)

      expect(outcome.headers).toEqual({ 'WWW-Authenticate': 'Bearer' })
    }
  })

  test('requireApiKey sends no challenge on a 503 or when the request passes', async () => {
    expect((await run(undefined, undefined)).headers).toEqual({})
    expect((await run(EXPECTED, `Bearer ${EXPECTED}`)).headers).toEqual({})
  })

  test('requireApiKey accepts the scheme in any letter case', async () => {
    expect((await run(EXPECTED, `bearer ${EXPECTED}`)).nextCalls).toBe(1)
    expect((await run(EXPECTED, `BEARER ${EXPECTED}`)).nextCalls).toBe(1)
  })

  test.each([
    ['a wrong token', `Bearer ${EXPECTED}x`],
    ['a token that is a prefix of the key', `Bearer ${EXPECTED.slice(0, -1)}`],
    ['a missing header', undefined],
    ['an empty header', ''],
    ['an empty token', 'Bearer '],
    ['a scheme with no token', 'Bearer'],
    ['a bare key with no scheme', EXPECTED],
    ['another scheme', `Basic ${EXPECTED}`],
    ['two spaces before the token', `Bearer  ${EXPECTED}`],
    ['a tab before the token', `Bearer\t${EXPECTED}`],
    ['trailing whitespace after the token', `Bearer ${EXPECTED} `],
    ['a trailing newline after the token', `Bearer ${EXPECTED}\n`],
    ['two tokens', `Bearer ${EXPECTED} ${EXPECTED}`],
    ['a leading space', ` Bearer ${EXPECTED}`],
    ['a scheme with a suffix', `Bearerx ${EXPECTED}`],
  ])('requireApiKey answers 401 for %s', async (_name, authorization) => {
    const outcome = await run(EXPECTED, authorization)

    expect(outcome.status).toBe(401)
    expect(outcome.body).toEqual({
      success: false,
      error: { name: 'Unauthorized', message: 'a valid API key is required' },
    })
    expect(outcome.nextCalls).toBe(0)
  })

  test('every rejection answers with the same body, so none says why', async () => {
    const bodies = await Promise.all(
      [undefined, 'Bearer ', EXPECTED, `Bearer ${EXPECTED}x`].map(async (header) => (await run(EXPECTED, header)).body),
    )

    expect(new Set(bodies.map((body) => JSON.stringify(body))).size).toBe(1)
  })

  test('the 401 body and the log do not echo the presented token, the expected key or either length', async () => {
    const presented = 'presented-'.concat('d'.repeat(20))
    const outcome = await run(EXPECTED, `Bearer ${presented}`)

    const everything = JSON.stringify([outcome.body, outcome.logged])
    expect(everything).not.toContain(presented)
    expect(everything).not.toContain(EXPECTED)
    expect(everything).not.toContain(String(presented.length))
    expect(everything).not.toContain(String(EXPECTED.length))
  })
})
