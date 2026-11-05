import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import type { OidcConfig } from '../../src/auth/config.ts'
import { codeChallenge, isAllowed, newPendingLogin, OidcClient, OidcLoginError } from '../../src/auth/oidc.ts'
import { startMockIssuer, type MockIssuer } from './mock-issuer.ts'

const CLIENT_ID = 'tracker-test-client'
const SUBJECT = 'subject-123'
const EMAIL = 'person@example.test'

let issuer: MockIssuer
let config: OidcConfig

beforeAll(async () => {
  issuer = await startMockIssuer(CLIENT_ID)
  config = {
    mode: 'oidc',
    issuer: issuer.issuer,
    clientId: CLIENT_ID,
    redirectUri: 'http://localhost:3000/auth/oidc/callback',
    scopes: ['openid', 'email'],
    allowedEmail: EMAIL,
  }
})

afterAll(async () => {
  await issuer.stop()
})

/** Runs the redirect out and the provider's approval, returning what the callback receives. */
async function approved(client: OidcClient, claims: Record<string, unknown>) {
  const pending = newPendingLogin()
  const url = await client.authorizationUrl(pending)
  return { pending, code: issuer.approve(url, claims) }
}

describe('the authorization request', () => {
  test('carries code flow, the client, the redirect, state, nonce and an S256 challenge', async () => {
    const pending = newPendingLogin()

    const url = new URL(await new OidcClient(config).authorizationUrl(pending))

    expect(url.origin + url.pathname).toBe(`${issuer.issuer}/authorize`)
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: config.redirectUri,
      scope: 'openid email',
      state: pending.state,
      nonce: pending.nonce,
      code_challenge: codeChallenge(pending.verifier),
      code_challenge_method: 'S256',
    })
    expect(pending.verifier.length).toBeGreaterThanOrEqual(43)
  })

  test('a discovery document naming another issuer is refused', async () => {
    const lying: typeof fetch = Object.assign(
      async () => Response.json({ issuer: 'https://elsewhere.example.test', authorization_endpoint: 'x', token_endpoint: 'y', jwks_uri: 'z' }),
      { preconnect: fetch.preconnect },
    )

    await expect(new OidcClient(config, lying).discover()).rejects.toBeInstanceOf(OidcLoginError)
  })
})

describe('completeLogin', () => {
  test("an issuer written with a trailing slash is matched as the provider writes it", async () => {
    const slashed = await startMockIssuer(CLIENT_ID, { trailingSlash: true })
    try {
      const client = new OidcClient({ ...config, issuer: slashed.issuer.replace(/\/$/, '') })
      const pending = newPendingLogin()
      const code = slashed.approve(await client.authorizationUrl(pending), { sub: SUBJECT, email: EMAIL, email_verified: true })

      expect((await client.completeLogin({ code, pending })).sub).toBe(SUBJECT)
    } finally {
      await slashed.stop()
    }
  })

  test('a verified ID token for the allowed email signs in, and the verifier reached the token endpoint', async () => {
    const client = new OidcClient(config)
    const { pending, code } = await approved(client, { sub: SUBJECT, email: EMAIL, email_verified: true })

    const claims = await client.completeLogin({ code, pending })

    expect(claims.sub).toBe(SUBJECT)
    expect(issuer.tokenRequests.at(-1)?.get('code_verifier')).toBe(pending.verifier)
    expect(issuer.tokenRequests.at(-1)?.has('client_secret')).toBe(false)
  })

  test('a client secret is sent when one is configured', async () => {
    const client = new OidcClient({ ...config, clientSecret: 'shh' })
    const { pending, code } = await approved(client, { sub: SUBJECT, email: EMAIL, email_verified: true })

    await client.completeLogin({ code, pending })

    expect(issuer.tokenRequests.at(-1)?.get('client_secret')).toBe('shh')
  })

  test('a wrong PKCE verifier is refused by the provider, and so here', async () => {
    const client = new OidcClient(config)
    const { pending, code } = await approved(client, { sub: SUBJECT, email: EMAIL, email_verified: true })

    await expect(client.completeLogin({ code, pending: { ...pending, verifier: newPendingLogin().verifier } })).rejects.toThrow(
      /token endpoint answered 400/,
    )
  })

  test.each([
    ['someone else', { sub: 'other', email: 'other@example.test', email_verified: true }],
    ['the right email, unverified', { sub: SUBJECT, email: EMAIL, email_verified: false }],
    ['no email', { sub: SUBJECT }],
  ])('an ID token for %s is refused', async (_label, claims) => {
    const client = new OidcClient(config)
    const approval = await approved(client, claims)

    await expect(client.completeLogin(approval)).rejects.toThrow(/someone else/)
  })

  test('an ID token with another nonce is refused', async () => {
    const client = new OidcClient(config)
    const { pending, code } = await approved(client, { sub: SUBJECT, email: EMAIL, email_verified: true })

    await expect(client.completeLogin({ code, pending: { ...pending, nonce: 'replayed' } })).rejects.toThrow(/nonce/)
  })

  test.each([
    ['signed by a key the issuer does not publish', { signWithOtherKey: true }],
    ['for another audience', { audience: 'another-client' }],
    ['from another issuer', { issuer: 'https://elsewhere.example.test' }],
  ])('an ID token %s does not verify', async (_label, tampering) => {
    const client = new OidcClient(config)
    const approval = await approved(client, { sub: SUBJECT, email: EMAIL, email_verified: true })
    issuer.tamper(tampering)

    await expect(client.completeLogin(approval)).rejects.toThrow(/did not verify/)
  })

  test('a token endpoint failure is refused', async () => {
    const client = new OidcClient(config)
    const approval = await approved(client, { sub: SUBJECT, email: EMAIL, email_verified: true })
    issuer.tamper({ status: 500 })

    await expect(client.completeLogin(approval)).rejects.toThrow(/500/)
  })
})

describe('isAllowed', () => {
  test('with a subject and an email configured, both must match', () => {
    const both: OidcConfig = { ...config, allowedSubject: SUBJECT }

    expect(isAllowed(both, { sub: SUBJECT, email: EMAIL, email_verified: true })).toBe(true)
    expect(isAllowed(both, { sub: 'other', email: EMAIL, email_verified: true })).toBe(false)
  })

  test('with a subject alone, the email is not looked at', () => {
    const { allowedEmail: _dropped, ...rest } = config
    const subjectOnly: OidcConfig = { ...rest, allowedSubject: SUBJECT }

    expect(isAllowed(subjectOnly, { sub: SUBJECT })).toBe(true)
  })

  test('the email is compared without case', () => {
    expect(isAllowed(config, { sub: 'x', email: 'Person@Example.TEST', email_verified: true })).toBe(true)
  })
})
