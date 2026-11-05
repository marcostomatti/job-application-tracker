import type { Request, Response } from 'express'

/** The session cookie: a signed random id. */
export const SESSION_COOKIE = 'jat_session'

/** The cookie that carries one OIDC attempt's state, nonce and verifier between the redirect and the callback. */
export const OIDC_COOKIE = 'jat_oidc'

/**
 * The header a browser write must carry when it is authenticated by cookie. A page on another
 * origin cannot add a custom header to a cross-site request without a CORS preflight, and this
 * service answers no preflight, so the header proves the request came from this app's own page.
 */
export const CSRF_HEADER = 'x-jat-csrf'

/** Methods that change nothing, and so need no CSRF header. */
export const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS'])

/** One cookie from the `Cookie` header, or `undefined`. A malformed header yields nothing rather than throwing. */
export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie
  if (typeof header !== 'string') return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0 || part.slice(0, eq).trim() !== name) continue
    try {
      return decodeURIComponent(part.slice(eq + 1).trim())
    } catch {
      return undefined
    }
  }
  return undefined
}

export interface CookieOptions {
  /** Seconds; 0 deletes the cookie. */
  readonly maxAge: number
  readonly path: string
  readonly secure: boolean
}

/**
 * Sets an httpOnly, SameSite=Lax cookie. Lax lets the OIDC provider's redirect back carry the
 * cookie (a top-level GET) and keeps it off cross-site POSTs. `Secure` is set when the request
 * came over HTTPS or `AUTH_COOKIE_SECURE=true`; a plain-HTTP localhost cannot keep a Secure cookie.
 */
export function setCookie(res: Response, name: string, value: string, options: CookieOptions): void {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${options.path}`,
    `Max-Age=${options.maxAge}`,
    'HttpOnly',
    'SameSite=Lax',
    ...(options.secure ? ['Secure'] : []),
  ]
  res.append('Set-Cookie', parts.join('; '))
}

/** Whether cookies on this response should be `Secure`. */
export function wantsSecureCookie(req: Request, env: NodeJS.ProcessEnv = process.env): boolean {
  return req.secure || env.AUTH_COOKIE_SECURE === 'true'
}
