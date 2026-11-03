import { describe, expect, test } from 'bun:test'
import type { Request, Response } from 'express'

import { requireApiKey, type AuthLog } from '../../src/auth/middleware.ts'

/** A stand-in secret built at run time, so no key-shaped literal sits in the repository. */
const EXPECTED = 'stand-in-secret-'.concat('b'.repeat(24))

type Outcome = {
  readonly nextCalls: number
  readonly status: number | undefined
  readonly body: unknown
  readonly logged: readonly { readonly context: object; readonly message: string }[]
}

/**
 * Drives the handler with a minimal request, response and `next`, and records what it did.
 * `authorization` is the raw header value, or absent when `undefined`.
 */
async function run(expected: string | undefined, authorization: string | undefined): Promise<Outcome> {
  let nextCalls = 0
  let status: number | undefined
  let body: unknown
  const logged: { context: object; message: string }[] = []
  const log: AuthLog = { error: (context, message) => void logged.push({ context, message }) }

  const req = { headers: authorization === undefined ? {} : { authorization } } as unknown as Request
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

  await requireApiKey(expected, log)(req, res, () => void (nextCalls += 1))
  return { nextCalls, status, body, logged }
}

describe('requireApiKey with no key configured', () => {
  test.each([
    ['undefined', undefined],
    ['an empty string', ''],
  ])('requireApiKey refuses every request when the key is %s', async (_name, expected) => {
    const headers = [undefined, '', 'Bearer ', `Bearer ${EXPECTED}`, 'Bearer ', 'Bearer undefined']
    for (const authorization of headers) {
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

  test('requireApiKey logs the reason for the 503 where a test can see it', async () => {
    const outcome = await run(undefined, `Bearer ${EXPECTED}`)

    expect(outcome.logged).toHaveLength(1)
    expect(outcome.logged[0]?.message).toContain('API_KEY')
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
    expect(outcome.body).toEqual({ error: 'unauthorized' })
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
