import { createLogger } from '@open-tomato/service-logger'
import type { RequestHandler } from 'express'

import { verifyApiKey } from './api-key.ts'

/**
 * Where the 503 for a missing key is reported. A caller can pass a spy to observe it; the
 * `service-logger` `Logger` satisfies this.
 */
export type AuthLog = { error(context: object, message: string): void }

let cachedLogger: AuthLog | undefined

/** The module's own logger, made on first use so importing this file starts no logger. */
function defaultLogger(): AuthLog {
  cachedLogger ??= createLogger('auth')
  return cachedLogger
}

/**
 * Exactly `Bearer`, one space, then a token with no whitespace in it. The scheme's letter
 * case is free (RFC 7235). Anything else, an extra space or a tab, a trailing character, a
 * second token or a bare key, fails the match and is treated as no credential: a parser
 * that trims or splits loosely is how a malformed header becomes an accepted one.
 */
const BEARER_HEADER = /^Bearer ([^\s]+)$/i

/** The bearer token in an `Authorization` header, or `undefined` when there is no well-formed one. */
function bearerToken(header: unknown): string | undefined {
  if (typeof header !== 'string') return undefined
  return BEARER_HEADER.exec(header)?.[1]
}

/**
 * Express middleware that lets a request through only when it carries `Authorization:
 * Bearer <expected>`. This app's only authentication; the chassis's `ctx.requireAuth` is
 * never used, because with no auth service configured it allows every request.
 *
 * It fails closed: when `expected` is undefined or empty, no key can be right, so every
 * request is refused with 503 and the reason logged. The "if a key is set, check it" form
 * of this check would instead allow everything, which is why that case is decided before
 * any header is read.
 *
 * Every rejected request gets the same 401 body, so a missing header, a malformed one and a
 * wrong key look alike. Neither a response nor a log line carries the presented value, the
 * expected key or either length.
 */
export function requireApiKey(expected: string | undefined, logger?: AuthLog): RequestHandler {
  if (expected === undefined || expected === '') {
    const log = logger ?? defaultLogger()
    return (_req, res) => {
      log.error({}, 'API_KEY is not set; refusing every request')
      res.status(503).json({ error: 'unavailable' })
    }
  }

  return (req, res, next) => {
    const presented = bearerToken(req.headers.authorization)
    if (presented === undefined || !verifyApiKey(presented, expected)) {
      res.status(401).json({ error: 'unauthorized' })
      return
    }
    next()
  }
}
