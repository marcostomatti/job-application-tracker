import { isPasswordHash } from './password-hash.ts'

/** No login: the web app cannot sign in, and only `API_KEY` opens `/api`. */
export interface NoLoginConfig {
  readonly mode: 'none'
}

/** One user who signs in with the password whose hash is `AUTH_PASSWORD_HASH`. */
export interface PasswordConfig {
  readonly mode: 'password'
  readonly passwordHash: string
}

/** One user who signs in at an OpenID Connect provider and is let in by subject or email. */
export interface OidcConfig {
  readonly mode: 'oidc'
  readonly issuer: string
  readonly clientId: string
  /** Absent for a public client, which proves itself with PKCE alone. */
  readonly clientSecret?: string
  readonly redirectUri: string
  readonly scopes: readonly string[]
  readonly allowedSubject?: string
  /** Lower-cased. Matched only against an email the provider marks verified. */
  readonly allowedEmail?: string
}

export type AuthConfig = NoLoginConfig | PasswordConfig | OidcConfig

/** Thrown at startup for a login setting that cannot work; the message names the setting and the fix. */
export class AuthConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AuthConfigError'
  }
}

const DEFAULT_SCOPES = ['openid', 'email'] as const

function value(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name]?.trim()
  return raw === undefined || raw === '' ? undefined : raw
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const found = value(env, name)
  if (found === undefined) throw new AuthConfigError(`AUTH_MODE=oidc needs ${name} in .env.`)
  return found
}

function absoluteUrl(raw: string, name: string): string {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('not http')
    return raw
  } catch {
    throw new AuthConfigError(`${name} must be an absolute http(s) URL.`)
  }
}

function passwordConfig(env: NodeJS.ProcessEnv): PasswordConfig {
  const hash = value(env, 'AUTH_PASSWORD_HASH')
  if (hash === undefined) {
    throw new AuthConfigError('AUTH_MODE=password needs AUTH_PASSWORD_HASH in .env. Run `bun run set-password` to write it.')
  }
  if (!isPasswordHash(hash)) {
    throw new AuthConfigError(
      'AUTH_PASSWORD_HASH is not a hash `bun run set-password` wrote (a plain password is not accepted). Run `bun run set-password`.',
    )
  }
  return { mode: 'password', passwordHash: hash }
}

function oidcConfig(env: NodeJS.ProcessEnv): OidcConfig {
  const issuer = absoluteUrl(required(env, 'OIDC_ISSUER'), 'OIDC_ISSUER')
  const redirectUri = absoluteUrl(required(env, 'OIDC_REDIRECT_URI'), 'OIDC_REDIRECT_URI')
  const allowedSubject = value(env, 'OIDC_ALLOWED_SUBJECT')
  const allowedEmail = value(env, 'OIDC_ALLOWED_EMAIL')?.toLowerCase()
  if (allowedSubject === undefined && allowedEmail === undefined) {
    throw new AuthConfigError('AUTH_MODE=oidc needs OIDC_ALLOWED_SUBJECT or OIDC_ALLOWED_EMAIL, so only one person can sign in.')
  }
  const clientSecret = value(env, 'OIDC_CLIENT_SECRET')
  const scopes = value(env, 'OIDC_SCOPES')?.split(/\s+/) ?? [...DEFAULT_SCOPES]
  return {
    mode: 'oidc',
    issuer: issuer.replace(/\/+$/, ''),
    clientId: required(env, 'OIDC_CLIENT_ID'),
    redirectUri,
    scopes: scopes.includes('openid') ? scopes : ['openid', ...scopes],
    ...(clientSecret === undefined ? {} : { clientSecret }),
    ...(allowedSubject === undefined ? {} : { allowedSubject }),
    ...(allowedEmail === undefined ? {} : { allowedEmail }),
  }
}

/**
 * The login mode from `AUTH_MODE`: unset or blank is `none`, and only `password` and `oidc` are
 * other modes. One mode at a time. A setting the chosen mode needs and lacks is refused here, at
 * startup, so a wrong `.env` never becomes a login page that lets nobody in, or anybody.
 */
export function parseAuthConfig(env: NodeJS.ProcessEnv): AuthConfig {
  const mode = value(env, 'AUTH_MODE')
  if (mode === undefined) return { mode: 'none' }
  if (mode === 'password') return passwordConfig(env)
  if (mode === 'oidc') return oidcConfig(env)
  throw new AuthConfigError(`AUTH_MODE must be \`password\` or \`oidc\` (or unset for no login); it is ${JSON.stringify(mode)}.`)
}
