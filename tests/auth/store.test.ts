import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'

import {
  clearCredentials,
  COOKIE_SECRET_KEY,
  cookieSecret,
  createSession,
  createToken,
  deleteSession,
  isLiveSession,
  listTokens,
  revokeToken,
  sign,
  tokenName,
  unsign,
  useToken,
} from '../../src/auth/store.ts'
import { apiToken, authSession } from '../../src/data/schema/auth.ts'
import { appConfig } from '../../src/data/schema/config.ts'
import { NotFoundError } from '../../src/errors.ts'
import { useSharedScratchDatabase } from '../mcp/tools/harness.ts'

const database = useSharedScratchDatabase()

describe('sign and unsign', () => {
  test('a signed value comes back; a changed value or signature does not', () => {
    const signed = sign('abc', 'secret-one')

    expect(unsign(signed, 'secret-one')).toBe('abc')
    expect(unsign(signed, 'secret-two')).toBeUndefined()
    expect(unsign(`x${signed}`, 'secret-one')).toBeUndefined()
    expect(unsign(`${signed}x`, 'secret-one')).toBeUndefined()
    expect(unsign('no-signature', 'secret-one')).toBeUndefined()
  })
})

describe('cookieSecret', () => {
  test('is made once and read back the same on every call', async () => {
    const first = await cookieSecret(database())
    const [second, third] = await Promise.all([cookieSecret(database()), cookieSecret(database())])

    expect(first.length).toBeGreaterThanOrEqual(32)
    expect(second).toBe(first)
    expect(third).toBe(first)
  })
})

describe('sessions', () => {
  test('a new session is live, and stores only a hash of its id', async () => {
    const id = await createSession(database())

    expect(await isLiveSession(database(), id)).toBe(true)
    const stored = await database().select().from(authSession)
    expect(stored.some((row) => row.idHash === id)).toBe(false)
  })

  test('an expired session is not live, and a later sign-in sweeps it', async () => {
    const longAgo = new Date('2020-01-01T00:00:00Z')
    const old = await createSession(database(), longAgo)

    expect(await isLiveSession(database(), old)).toBe(false)
    await createSession(database())
    const rows = await database().select().from(authSession)
    expect(rows.every((row) => row.expiresAt > new Date())).toBe(true)
  })

  test('a deleted session is no longer live, and an unknown id never was', async () => {
    const id = await createSession(database())

    await deleteSession(database(), id)

    expect(await isLiveSession(database(), id)).toBe(false)
    expect(await isLiveSession(database(), 'never-issued')).toBe(false)
  })
})

describe('API tokens', () => {
  test('a minted token is shown once, stored as a hash, and opens access', async () => {
    const { token, summary } = await createToken(database(), 'research agent')

    expect(token.startsWith('jat_')).toBe(true)
    expect(summary).toMatchObject({ name: 'research agent', prefix: token.slice(0, 8), lastUsedAt: null, revokedAt: null })
    const [row] = await database().select().from(apiToken).where(eq(apiToken.id, summary.id))
    expect(row?.tokenHash).not.toContain(token)
    expect(JSON.stringify(await listTokens(database()))).not.toContain(token)
    expect(await useToken(database(), token)).toBe(true)
  })

  test('using a token records when', async () => {
    const { token, summary } = await createToken(database(), 'cli')

    await useToken(database(), token)

    const listed = (await listTokens(database())).find((entry) => entry.id === summary.id)
    expect(listed?.lastUsedAt).not.toBeNull()
  })

  test('a revoked token stays listed and opens nothing', async () => {
    const { token, summary } = await createToken(database(), 'to revoke')

    const revoked = await revokeToken(database(), summary.id)
    const again = await revokeToken(database(), summary.id)

    expect(revoked.revokedAt).not.toBeNull()
    expect(again.revokedAt).toBe(revoked.revokedAt)
    expect(await useToken(database(), token)).toBe(false)
    expect((await listTokens(database())).some((entry) => entry.id === summary.id)).toBe(true)
  })

  test('revoking a token that does not exist is a NotFoundError', async () => {
    await expect(revokeToken(database(), 999_999)).rejects.toBeInstanceOf(NotFoundError)
  })

  test('an unknown token opens nothing', async () => {
    expect(await useToken(database(), 'jat_not-a-real-token')).toBe(false)
  })

  test.each([['', 'empty'], ['   ', 'blank'], ['x'.repeat(81), 'too long'], [42, 'not text']])(
    'a token name %p (%s) is refused',
    (raw) => {
      expect(() => tokenName(raw)).toThrow(/name/)
    },
  )

  test('a token name is trimmed', () => {
    expect(tokenName('  laptop  ')).toBe('laptop')
  })
})

describe('clearCredentials', () => {
  test('removes every session, every token and the cookie secret', async () => {
    await createSession(database())
    const { token } = await createToken(database(), 'cleared')
    await cookieSecret(database())

    const cleared = await clearCredentials(database())

    expect(cleared.sessions).toBeGreaterThan(0)
    expect(cleared.tokens).toBeGreaterThan(0)
    expect(await database().select().from(authSession)).toEqual([])
    expect(await database().select().from(apiToken)).toEqual([])
    expect(await database().select().from(appConfig).where(eq(appConfig.key, COOKIE_SECRET_KEY))).toEqual([])
    expect(await useToken(database(), token)).toBe(false)
  })
})
