import { createHash, randomBytes } from 'node:crypto'

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose'

import type { OidcConfig } from './config.ts'

/** The three endpoints this app uses from a provider's discovery document. */
export interface OidcEndpoints {
  /** The issuer exactly as the provider writes it, trailing slash and all, which is what its ID tokens carry in `iss`. */
  readonly issuer: string
  readonly authorizationEndpoint: string
  readonly tokenEndpoint: string
  readonly jwksUri: string
}

/** What one sign-in attempt keeps between the redirect out and the callback: in a signed cookie, never in the database. */
export interface PendingLogin {
  readonly state: string
  readonly nonce: string
  readonly verifier: string
}

/** Why a callback was refused. Logged by this name; the browser sees one generic message. */
export class OidcLoginError extends Error {
  constructor(readonly reason: string) {
    super(`OIDC sign-in refused: ${reason}`)
    this.name = 'OidcLoginError'
  }
}

const random = (bytes: number): string => randomBytes(bytes).toString('base64url')

/** A fresh state, nonce and PKCE verifier (RFC 7636: 43 to 128 characters). */
export function newPendingLogin(): PendingLogin {
  return { state: random(24), nonce: random(24), verifier: random(48) }
}

/** The S256 challenge for a verifier: base64url(SHA-256(verifier)). */
export function codeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

function endpoint(document: Record<string, unknown>, name: string): string {
  const found = document[name]
  if (typeof found !== 'string' || found === '') throw new OidcLoginError(`the discovery document has no ${name}`)
  return found
}

/** Fetches what a client needs to know about a provider, by standard discovery (OpenID Connect Discovery 1.0). */
export class OidcClient {
  private endpoints: Promise<OidcEndpoints> | undefined
  private jwks: ReturnType<typeof createRemoteJWKSet> | undefined

  constructor(
    private readonly config: OidcConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** The provider's endpoints, fetched once; a failed fetch is forgotten so the next sign-in tries again. */
  discover(): Promise<OidcEndpoints> {
    this.endpoints ??= this.fetchDiscovery().catch((error: unknown) => {
      this.endpoints = undefined
      throw error
    })
    return this.endpoints
  }

  private async fetchDiscovery(): Promise<OidcEndpoints> {
    const response = await this.fetchImpl(`${this.config.issuer}/.well-known/openid-configuration`, {
      headers: { accept: 'application/json' },
    })
    if (!response.ok) throw new OidcLoginError(`discovery answered ${response.status}`)
    const document = (await response.json()) as Record<string, unknown>
    // A document for another issuer is refused, so a wrong OIDC_ISSUER fails at the first sign-in.
    if (typeof document.issuer !== 'string' || document.issuer.replace(/\/+$/, '') !== this.config.issuer) {
      throw new OidcLoginError('the discovery document names another issuer')
    }
    return {
      issuer: document.issuer,
      authorizationEndpoint: endpoint(document, 'authorization_endpoint'),
      tokenEndpoint: endpoint(document, 'token_endpoint'),
      jwksUri: endpoint(document, 'jwks_uri'),
    }
  }

  /** The provider URL the browser is sent to, carrying the state, the nonce and the PKCE challenge. */
  async authorizationUrl(pending: PendingLogin): Promise<string> {
    const { authorizationEndpoint } = await this.discover()
    const url = new URL(authorizationEndpoint)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('client_id', this.config.clientId)
    url.searchParams.set('redirect_uri', this.config.redirectUri)
    url.searchParams.set('scope', this.config.scopes.join(' '))
    url.searchParams.set('state', pending.state)
    url.searchParams.set('nonce', pending.nonce)
    url.searchParams.set('code_challenge', codeChallenge(pending.verifier))
    url.searchParams.set('code_challenge_method', 'S256')
    return url.toString()
  }

  /**
   * Trades the code for tokens, verifies the ID token (signature against the issuer's JWKS,
   * `iss`, `aud`, expiry, `nonce`) and checks it names the one allowed person. Throws an
   * `OidcLoginError` for every refusal.
   */
  async completeLogin(input: { code: string; pending: PendingLogin }): Promise<JWTPayload> {
    const { issuer, tokenEndpoint, jwksUri } = await this.discover()
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: this.config.redirectUri,
      client_id: this.config.clientId,
      code_verifier: input.pending.verifier,
      ...(this.config.clientSecret === undefined ? {} : { client_secret: this.config.clientSecret }),
    })
    const response = await this.fetchImpl(tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
    })
    if (!response.ok) throw new OidcLoginError(`the token endpoint answered ${response.status}`)
    const tokens = (await response.json()) as { id_token?: unknown }
    if (typeof tokens.id_token !== 'string') throw new OidcLoginError('the token response has no id_token')

    this.jwks ??= createRemoteJWKSet(new URL(jwksUri))
    let claims: JWTPayload
    try {
      claims = (await jwtVerify(tokens.id_token, this.jwks, {
        issuer,
        audience: this.config.clientId,
        requiredClaims: ['exp', 'iat', 'sub'],
      })).payload
    } catch (error: unknown) {
      throw new OidcLoginError(`the id_token did not verify (${error instanceof Error ? error.name : 'unknown'})`)
    }
    if (claims.nonce !== input.pending.nonce) throw new OidcLoginError('the id_token nonce does not match')
    if (!isAllowed(this.config, claims)) throw new OidcLoginError('the id_token names someone else')
    return claims
  }
}

/**
 * Whether the claims name the one allowed person. With both settings, both must match. An email
 * counts only when the provider says it is verified, because an unverified email is whatever
 * the person typed at the provider.
 */
export function isAllowed(config: OidcConfig, claims: JWTPayload): boolean {
  const subjectOk = config.allowedSubject === undefined || claims.sub === config.allowedSubject
  const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : undefined
  const emailOk = config.allowedEmail === undefined || (claims.email_verified === true && email === config.allowedEmail)
  return subjectOk && emailOk
}
