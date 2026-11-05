import { createHash, randomBytes } from 'node:crypto'

import { exportJWK, generateKeyPair, SignJWT, type JWK, type JWTPayload } from 'jose'

/** What the mock puts in an ID token beyond iss, aud, iat and exp. Each test picks its own. */
export type IdClaims = JWTPayload & { email?: string; email_verified?: boolean; nonce?: string }

/** An OpenID provider in this process, for tests only. It never reaches a real one. */
export interface MockIssuer {
  readonly issuer: string
  /** What the provider would do at its login screen: issue a code for these claims, bound to the authorization request. */
  approve(authorizationUrl: string, claims: IdClaims): string
  /** Overrides for the next token response, to test refusals. */
  tamper(next: { idToken?: string; status?: number; audience?: string; issuer?: string; signWithOtherKey?: boolean }): void
  /** A signed ID token, for building tampered responses. */
  sign(claims: IdClaims, options?: { audience?: string; issuer?: string; otherKey?: boolean }): Promise<string>
  readonly tokenRequests: URLSearchParams[]
  stop(): Promise<void>
}

type Grant = { claims: IdClaims; clientId: string; redirectUri: string; challenge: string; nonce: string }

/**
 * Starts a provider on an ephemeral loopback port: discovery, a JWKS with one RSA key, and a
 * token endpoint that checks the code, the redirect URI and the PKCE verifier as a real one does.
 */
export async function startMockIssuer(clientId: string, options: { trailingSlash?: boolean } = {}): Promise<MockIssuer> {
  const { privateKey, publicKey } = await generateKeyPair('RS256')
  const other = await generateKeyPair('RS256')
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }
  const grants = new Map<string, Grant>()
  const tokenRequests: URLSearchParams[] = []
  let tampering: Parameters<MockIssuer['tamper']>[0] = {}

  let issuer = ''
  const base = (): string => issuer.replace(/\/$/, '')
  const server: ReturnType<typeof Bun.serve> = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async (request: Request): Promise<Response> => {
      const url = new URL(request.url)
      if (url.pathname === '/.well-known/openid-configuration') {
        return Response.json({
          issuer,
          authorization_endpoint: `${base()}/authorize`,
          token_endpoint: `${base()}/token`,
          jwks_uri: `${base()}/jwks`,
        })
      }
      if (url.pathname === '/jwks') return Response.json({ keys: [jwk] })
      if (url.pathname === '/token' && request.method === 'POST') return token(new URLSearchParams(await request.text()))
      return new Response('not found', { status: 404 })
    },
  })
  const origin = `http://127.0.0.1:${server.port}`
  issuer = options.trailingSlash ? `${origin}/` : origin

  async function sign(claims: IdClaims, options: { audience?: string; issuer?: string; otherKey?: boolean } = {}): Promise<string> {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(options.issuer ?? issuer)
      .setAudience(options.audience ?? clientId)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(options.otherKey ? other.privateKey : privateKey)
  }

  async function token(form: URLSearchParams): Promise<Response> {
    tokenRequests.push(form)
    const now = tampering
    tampering = {}
    if (now.status !== undefined) return Response.json({ error: 'server_error' }, { status: now.status })
    const grant = grants.get(form.get('code') ?? '')
    grants.delete(form.get('code') ?? '')
    const verifier = form.get('code_verifier') ?? ''
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    if (
      !grant ||
      form.get('grant_type') !== 'authorization_code' ||
      form.get('client_id') !== grant.clientId ||
      form.get('redirect_uri') !== grant.redirectUri ||
      challenge !== grant.challenge
    ) {
      return Response.json({ error: 'invalid_grant' }, { status: 400 })
    }
    const idToken =
      now.idToken ??
      (await sign(
        { nonce: grant.nonce, ...grant.claims },
        { audience: now.audience, issuer: now.issuer, otherKey: now.signWithOtherKey },
      ))
    return Response.json({ id_token: idToken, access_token: 'unused', token_type: 'Bearer' })
  }

  return {
    issuer,
    approve(authorizationUrl, claims): string {
      const url = new URL(authorizationUrl)
      const code = randomBytes(12).toString('base64url')
      grants.set(code, {
        claims,
        clientId: url.searchParams.get('client_id') ?? '',
        redirectUri: url.searchParams.get('redirect_uri') ?? '',
        challenge: url.searchParams.get('code_challenge') ?? '',
        nonce: url.searchParams.get('nonce') ?? '',
      })
      return code
    },
    tamper(next): void {
      tampering = next
    },
    sign,
    tokenRequests,
    async stop(): Promise<void> {
      await server.stop(true)
    },
  }
}
