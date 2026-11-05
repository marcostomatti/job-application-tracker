import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

import { and, desc, eq, gt, isNull, lte, sql } from 'drizzle-orm'

import type { Db } from '../data/repositories/db.ts'
import { apiToken, authSession } from '../data/schema/auth.ts'
import { appConfig } from '../data/schema/config.ts'
import { NotFoundError } from '../errors.ts'
import { generateApiKey } from './api-key.ts'

/** The `app_config` key holding the secret that signs cookies. `reset-credentials` deletes it. */
export const COOKIE_SECRET_KEY = 'auth_cookie_secret'

/** How long a sign-in lasts. */
export const SESSION_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000

/** How many leading characters of a token the list shows: `jat_` and four more. */
const TOKEN_PREFIX_LENGTH = 8

const TOKEN_NAME_MAX = 80

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

// --- the cookie secret -------------------------------------------------------

/**
 * The secret cookies are signed with: made on first use and kept in `app_config`, so there is no
 * extra setting to write and a restart keeps everyone signed in. Two first uses at once both
 * insert; the conflict keeps the first, and both read it back.
 */
export async function cookieSecret(db: Db): Promise<string> {
  const fresh = randomBytes(32).toString('base64url')
  await db.insert(appConfig).values({ key: COOKIE_SECRET_KEY, value: fresh }).onConflictDoNothing()
  const [row] = await db.select({ value: appConfig.value }).from(appConfig).where(eq(appConfig.key, COOKIE_SECRET_KEY))
  if (typeof row?.value !== 'string' || row.value.length < 32) throw new Error('the cookie secret in app_config is unusable')
  return row.value
}

/** `value.signature`, the signature an HMAC-SHA256 of `value` under `secret`. */
export function sign(value: string, secret: string): string {
  return `${value}.${createHmac('sha256', secret).update(value).digest('base64url')}`
}

/** The value of a `sign` result when its signature is right, else `undefined`. */
export function unsign(signed: string, secret: string): string | undefined {
  const dot = signed.lastIndexOf('.')
  if (dot <= 0) return undefined
  const value = signed.slice(0, dot)
  const expected = Buffer.from(sign(value, secret).slice(dot + 1))
  const presented = Buffer.from(signed.slice(dot + 1))
  return expected.length === presented.length && timingSafeEqual(expected, presented) ? value : undefined
}

// --- sessions ------------------------------------------------------------------

/** Starts a session and returns its id, which only the cookie carries. */
export async function createSession(db: Db, now: Date = new Date()): Promise<string> {
  const id = randomBytes(32).toString('base64url')
  await db.insert(authSession).values({ idHash: sha256(id), expiresAt: new Date(now.getTime() + SESSION_DAYS * DAY_MS) })
  // Expired rows are swept on each sign-in, so the table stays the size of the live sessions.
  await db.delete(authSession).where(lte(authSession.expiresAt, now))
  return id
}

/** Whether `id` names a session that has not expired. */
export async function isLiveSession(db: Db, id: string, now: Date = new Date()): Promise<boolean> {
  const rows = await db
    .select({ idHash: authSession.idHash })
    .from(authSession)
    .where(and(eq(authSession.idHash, sha256(id)), gt(authSession.expiresAt, now)))
  return rows.length > 0
}

export async function deleteSession(db: Db, id: string): Promise<void> {
  await db.delete(authSession).where(eq(authSession.idHash, sha256(id)))
}

// --- API tokens ------------------------------------------------------------------

/** What the token list shows of one token. The token itself is never stored, so it is never listed. */
export interface TokenSummary {
  readonly id: number
  readonly name: string
  readonly prefix: string
  readonly createdAt: string
  readonly lastUsedAt: string | null
  readonly revokedAt: string | null
}

function summary(row: typeof apiToken.$inferSelect): TokenSummary {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  }
}

/** The name a token is listed under: trimmed, 1 to 80 characters. Throws a plain Error the route turns into a 400. */
export function tokenName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : ''
  if (name.length === 0 || name.length > TOKEN_NAME_MAX) {
    throw new Error(`a token needs a name of 1 to ${TOKEN_NAME_MAX} characters`)
  }
  return name
}

/** Mints a token and returns it with its summary. The token is in the result once and nowhere else. */
export async function createToken(db: Db, name: string): Promise<{ token: string; summary: TokenSummary }> {
  const token = generateApiKey()
  const [row] = await db
    .insert(apiToken)
    .values({ name, tokenHash: sha256(token), prefix: token.slice(0, TOKEN_PREFIX_LENGTH) })
    .returning()
  if (!row) throw new Error('the token was not stored')
  return { token, summary: summary(row) }
}

/** Every token, newest first, revoked ones included. */
export async function listTokens(db: Db): Promise<TokenSummary[]> {
  const rows = await db.select().from(apiToken).orderBy(desc(apiToken.createdAt), desc(apiToken.id))
  return rows.map(summary)
}

/** Revokes a token. Revoking one already revoked keeps its first `revoked_at`. */
export async function revokeToken(db: Db, id: number): Promise<TokenSummary> {
  await db.update(apiToken).set({ revokedAt: sql`now()` }).where(and(eq(apiToken.id, id), isNull(apiToken.revokedAt)))
  const [row] = await db.select().from(apiToken).where(eq(apiToken.id, id))
  if (!row) throw new NotFoundError('API token', id)
  return summary(row)
}

/**
 * Whether `presented` is a token that has not been revoked, recording the use when it is. The
 * lookup is by SHA-256, an index match on a 256-bit random value, so there is nothing to time.
 */
export async function useToken(db: Db, presented: string): Promise<boolean> {
  const used = await db
    .update(apiToken)
    .set({ lastUsedAt: sql`now()` })
    .where(and(eq(apiToken.tokenHash, sha256(presented)), isNull(apiToken.revokedAt)))
    .returning({ id: apiToken.id })
  return used.length > 0
}

/** What `clearCredentials` removed. */
export interface ClearedCredentials {
  readonly sessions: number
  readonly tokens: number
}

/** Deletes every session, every token and the cookie secret, in one transaction. */
export async function clearCredentials(db: Db): Promise<ClearedCredentials> {
  return db.transaction(async (tx) => {
    const sessions = await tx.delete(authSession).returning({ idHash: authSession.idHash })
    const tokens = await tx.delete(apiToken).returning({ id: apiToken.id })
    await tx.delete(appConfig).where(eq(appConfig.key, COOKIE_SECRET_KEY))
    return { sessions: sessions.length, tokens: tokens.length }
  })
}
