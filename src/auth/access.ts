import type { Request, RequestHandler } from 'express'

import type { Db } from '../data/repositories/db.ts'
import { lazyLogger } from '../logging.ts'
import { verifyApiKey } from './api-key.ts'
import { bearerToken } from './middleware.ts'
import { CSRF_HEADER, readCookie, SAFE_METHODS, SESSION_COOKIE } from './cookies.ts'
import { cookieSecret, isLiveSession, unsign, useToken } from './store.ts'

const defaultLogger = lazyLogger('auth')

const UNAUTHORIZED_BODY = {
  success: false,
  error: { name: 'Unauthorized', message: 'a valid API key, API token or sign-in is required' },
} as const

const CSRF_BODY = {
  success: false,
  error: { name: 'Forbidden', message: `a signed-in browser write must send the ${CSRF_HEADER} header` },
} as const

/** How a request proved who it is, or `undefined` when it did not. */
export type Credential = 'api-key' | 'api-token' | 'session'

/** The session id in a request's signed cookie when the session is live, else `undefined`. */
export async function liveSessionId(req: Request, db: Db): Promise<string | undefined> {
  const signed = readCookie(req, SESSION_COOKIE)
  if (signed === undefined) return undefined
  const id = unsign(signed, await cookieSecret(db))
  if (id === undefined) return undefined
  return (await isLiveSession(db, id)) ? id : undefined
}

/**
 * Which credential the request carries, checked in this order: a bearer token is the
 * `API_KEY` or a minted API token, and otherwise a signed session cookie. A bearer that is
 * present and wrong is a refusal even when a good cookie is present too, so a client never
 * learns which of two credentials failed.
 */
export async function credentialOf(req: Request, db: Db, apiKey: string | undefined): Promise<Credential | undefined> {
  const header = req.headers.authorization
  if (header !== undefined) {
    // The strict form `requireApiKey` reads: `Bearer`, one space, one token.
    const presented = bearerToken(header)
    if (presented === undefined) return undefined
    if (apiKey !== undefined && apiKey !== '' && verifyApiKey(presented, apiKey)) return 'api-key'
    return (await useToken(db, presented)) ? 'api-token' : undefined
  }
  return (await liveSessionId(req, db)) === undefined ? undefined : 'session'
}

/**
 * Lets a request into `/api` when it carries the `API_KEY`, an unrevoked API token, or a live
 * session cookie. A cookie-authenticated write must also carry the CSRF header. Every refusal
 * is the same 401 body, as `requireApiKey`'s was, and nothing presented is logged.
 */
export function requireApiAccess(db: Db, apiKey: string | undefined): RequestHandler {
  return async (req, res, next) => {
    let credential: Credential | undefined
    try {
      credential = await credentialOf(req, db, apiKey)
    } catch (error: unknown) {
      defaultLogger().error({ reason: error instanceof Error ? error.name : 'unknown' }, 'the credential check failed')
      res.status(500).json({ success: false, error: { name: 'InternalError', message: 'internal error' } })
      return
    }
    if (credential === undefined) {
      res.set('WWW-Authenticate', 'Bearer').status(401).json(UNAUTHORIZED_BODY)
      return
    }
    if (credential === 'session' && !SAFE_METHODS.has(req.method) && req.get(CSRF_HEADER) !== '1') {
      res.status(403).json(CSRF_BODY)
      return
    }
    next()
  }
}
