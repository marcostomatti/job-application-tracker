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
 * The two bodies this middleware sends, in the envelope every `/api` route uses
 * (`{ success: false, error: { name, message } }`), so a client reads `body.error.message`
 * on every status. `message` is one fixed string per body: the 401's says nothing about which
 * check failed.
 */
const UNAUTHORIZED_BODY = {
  success: false,
  error: { name: 'Unauthorized', message: 'a valid API key is required' },
} as const
const UNAVAILABLE_BODY = {
  success: false,
  error: { name: 'Unavailable', message: 'the service is not configured to accept requests' },
} as const

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
 * request is refused with 503 and the reason logged once, when the middleware is created. The
 * "if a key is set, check it" form of this check would instead allow everything, which is why
 * that case is decided before any header is read, and why the handler returned for it never
 * touches the request at all.
 *
 * Every rejected request gets the same 401 body, so a missing header, a malformed one and a
 * wrong key look alike. Neither a response nor a log line carries the presented value, the
 * expected key or either length.
 */
export function requireApiKey(expected: string | undefined, logger?: AuthLog): RequestHandler {
  if (expected === undefined || expected === '') {
    // Logged once, here: an unset key is a fact about the configuration, known before any
    // request arrives, so the operator is told at startup and a retrying caller writes no
    // line per attempt.
    const log = logger ?? defaultLogger()
    log.error({}, 'API_KEY is not set; refusing every request')
    return (_req, res) => {
      res.status(503).json(UNAVAILABLE_BODY)
    }
  }

  return (req, res, next) => {
    const presented = bearerToken(req.headers.authorization)
    if (presented === undefined || !verifyApiKey(presented, expected)) {
      // RFC 7235 requires a challenge on a 401. It names the scheme only, so it says nothing
      // about why this request failed.
      res.set('WWW-Authenticate', 'Bearer').status(401).json(UNAUTHORIZED_BODY)
      return
    }
    next()
  }
}
