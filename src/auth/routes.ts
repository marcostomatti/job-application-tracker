import { Router, type Request, type RequestHandler, type Response } from 'express'
import { z } from 'zod'

import type { Db } from '../data/repositories/db.ts'
import { sendFailure } from '../http/handler.ts'
import { lazyLogger } from '../logging.ts'
import { liveSessionId } from './access.ts'
import type { AuthConfig } from './config.ts'
import { CSRF_HEADER, OIDC_COOKIE, readCookie, SAFE_METHODS, SESSION_COOKIE, setCookie, wantsSecureCookie } from './cookies.ts'
import { LoginThrottle } from './login-throttle.ts'
import { newPendingLogin, OidcClient, OidcLoginError, type PendingLogin } from './oidc.ts'
import { verifyPassword } from './password-hash.ts'
import {
  cookieSecret,
  createSession,
  createToken,
  deleteSession,
  listTokens,
  revokeToken,
  SESSION_DAYS,
  sign,
  tokenName,
  unsign,
} from './store.ts'

const defaultLogger = lazyLogger('auth')

const SESSION_MAX_AGE = SESSION_DAYS * 24 * 60 * 60

/** An OIDC attempt has ten minutes to come back from the provider. */
const OIDC_MAX_AGE = 10 * 60
const OIDC_COOKIE_PATH = '/auth/oidc'

/** Where the browser lands after signing in, and where a refused OIDC sign-in is sent. */
const HOME = '/'
const LOGIN_FAILED = '/login?error=oidc'

function fail(res: Response, status: number, name: string, message: string): void {
  res.status(status).json({ success: false, error: { name, message } })
}

/** Refuses an unsafe method without the CSRF header, so another site cannot sign this browser in or out. */
const requireCsrfHeader: RequestHandler = (req, res, next) => {
  if (!SAFE_METHODS.has(req.method) && req.get(CSRF_HEADER) !== '1') {
    fail(res, 403, 'Forbidden', `this request must send the ${CSRF_HEADER} header`)
    return
  }
  next()
}

/** Lets a request through only with a live session: token management is for a person, never for a token. */
function requireSession(db: Db): RequestHandler {
  return async (req, res, next) => {
    try {
      if ((await liveSessionId(req, db)) !== undefined) return next()
      fail(res, 401, 'Unauthorized', 'sign in first')
    } catch (error: unknown) {
      sendFailure(res, error)
    }
  }
}

async function startSession(req: Request, res: Response, db: Db): Promise<void> {
  const id = await createSession(db)
  setCookie(res, SESSION_COOKIE, sign(id, await cookieSecret(db)), {
    maxAge: SESSION_MAX_AGE,
    path: '/',
    secure: wantsSecureCookie(req),
  })
}

const LoginBody = z.object({ password: z.string().min(1).max(1024) })

function passwordLogin(db: Db, passwordHash: string, throttle: LoginThrottle): RequestHandler {
  return async (req, res) => {
    const body = LoginBody.safeParse(req.body)
    if (!body.success) return fail(res, 400, 'ValidationError', 'password: a password is required')
    const retryAfter = throttle.begin()
    if (retryAfter > 0) {
      res.set('Retry-After', String(retryAfter))
      fail(res, 429, 'TooManyAttempts', `too many wrong passwords; try again in ${retryAfter} seconds`)
      return
    }
    try {
      if (!(await verifyPassword(body.data.password, passwordHash))) {
        return fail(res, 401, 'Unauthorized', 'wrong password')
      }
      throttle.succeeded()
      await startSession(req, res, db)
      res.json({ success: true, data: { signedIn: true } })
    } catch (error: unknown) {
      sendFailure(res, error)
    }
  }
}

const PendingShape = z.object({ state: z.string(), nonce: z.string(), verifier: z.string() })

/** The pending OIDC attempt in this browser's signed cookie, or `undefined` when there is none or it was tampered with. */
function readPending(req: Request, secret: string): PendingLogin | undefined {
  const signed = readCookie(req, OIDC_COOKIE)
  const json = signed === undefined ? undefined : unsign(signed, secret)
  if (json === undefined) return undefined
  try {
    const parsed = PendingShape.safeParse(JSON.parse(json))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

function oidcRoutes(router: Router, db: Db, client: OidcClient): void {
  router.get('/oidc/start', async (req, res) => {
    try {
      const pending = newPendingLogin()
      const url = await client.authorizationUrl(pending)
      setCookie(res, OIDC_COOKIE, sign(JSON.stringify(pending), await cookieSecret(db)), {
        maxAge: OIDC_MAX_AGE,
        path: OIDC_COOKIE_PATH,
        secure: wantsSecureCookie(req),
      })
      res.redirect(302, url)
    } catch (error: unknown) {
      defaultLogger().error({ reason: error instanceof OidcLoginError ? error.reason : 'unknown' }, 'OIDC sign-in could not start')
      res.redirect(302, LOGIN_FAILED)
    }
  })

  router.get('/oidc/callback', async (req, res) => {
    // The attempt is single-use: its cookie is cleared whether the callback succeeds or not.
    setCookie(res, OIDC_COOKIE, '', { maxAge: 0, path: OIDC_COOKIE_PATH, secure: wantsSecureCookie(req) })
    try {
      const pending = readPending(req, await cookieSecret(db))
      const code = typeof req.query.code === 'string' ? req.query.code : undefined
      if (pending === undefined) throw new OidcLoginError('no sign-in attempt is pending in this browser')
      if (req.query.state !== pending.state) throw new OidcLoginError('the state does not match')
      if (code === undefined) throw new OidcLoginError('the provider sent no code')
      await client.completeLogin({ code, pending })
      await startSession(req, res, db)
      res.redirect(302, HOME)
    } catch (error: unknown) {
      defaultLogger().warn({ reason: error instanceof OidcLoginError ? error.reason : 'unknown' }, 'OIDC sign-in refused')
      res.redirect(302, LOGIN_FAILED)
    }
  })
}

function tokenRoutes(router: Router, db: Db): void {
  const session = requireSession(db)
  router.get('/tokens', session, async (_req, res) => {
    try {
      res.json({ success: true, data: await listTokens(db) })
    } catch (error: unknown) {
      sendFailure(res, error)
    }
  })
  router.post('/tokens', session, async (req, res) => {
    let name: string
    try {
      name = tokenName((req.body as { name?: unknown } | undefined)?.name)
    } catch (error: unknown) {
      return fail(res, 400, 'ValidationError', `name: ${(error as Error).message}`)
    }
    try {
      res.status(201).json({ success: true, data: await createToken(db, name) })
    } catch (error: unknown) {
      sendFailure(res, error)
    }
  })
  router.delete('/tokens/:id', session, async (req, res) => {
    const id = z.coerce.number().int().positive().max(2_147_483_647).safeParse(req.params.id)
    if (!id.success) return fail(res, 400, 'ValidationError', 'id: must be a positive whole number')
    try {
      res.json({ success: true, data: await revokeToken(db, id.data) })
    } catch (error: unknown) {
      sendFailure(res, error)
    }
  })
}

/** What the routes need beyond the database. A test passes its own OIDC client and throttle. */
export interface AuthRouteOptions {
  readonly oidcClient?: OidcClient
  readonly throttle?: LoginThrottle
}

/**
 * The `/auth` routes: which mode is on and whether this browser is signed in, the sign-in for
 * that mode, sign-out, and the API token list. Every unsafe method needs the CSRF header.
 */
export function authRouter(db: Db, config: AuthConfig, options: AuthRouteOptions = {}): Router {
  const router = Router()
  router.use(requireCsrfHeader)

  router.get('/session', async (req, res) => {
    try {
      const signedIn = config.mode !== 'none' && (await liveSessionId(req, db)) !== undefined
      res.json({ success: true, data: { mode: config.mode, signedIn } })
    } catch (error: unknown) {
      sendFailure(res, error)
    }
  })

  router.post('/logout', async (req, res) => {
    try {
      const id = await liveSessionId(req, db)
      if (id !== undefined) await deleteSession(db, id)
      setCookie(res, SESSION_COOKIE, '', { maxAge: 0, path: '/', secure: wantsSecureCookie(req) })
      res.json({ success: true, data: { signedIn: false } })
    } catch (error: unknown) {
      sendFailure(res, error)
    }
  })

  if (config.mode === 'password') {
    router.post('/login', passwordLogin(db, config.passwordHash, options.throttle ?? new LoginThrottle()))
  }
  if (config.mode === 'oidc') oidcRoutes(router, db, options.oidcClient ?? new OidcClient(config))
  if (config.mode !== 'none') tokenRoutes(router, db)

  router.use((_req, res) => fail(res, 404, 'NotFoundError', 'no such auth route for this AUTH_MODE'))
  return router
}
