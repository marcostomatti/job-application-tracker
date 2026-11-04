import { describe, expect, test } from 'bun:test'

import { AuthConfigError, parseAuthConfig } from '../../src/auth/config.ts'
import { hashPassword } from '../../src/auth/password-hash.ts'

const OIDC_BASE = {
  AUTH_MODE: 'oidc',
  OIDC_ISSUER: 'https://issuer.example.test/',
  OIDC_CLIENT_ID: 'tracker-client',
  OIDC_REDIRECT_URI: 'http://localhost:3000/auth/oidc/callback',
  OIDC_ALLOWED_EMAIL: 'Person@Example.test',
}

describe('parseAuthConfig', () => {
  test.each([{}, { AUTH_MODE: '' }, { AUTH_MODE: '  ' }])('an unset or blank AUTH_MODE means no login', (env) => {
    expect(parseAuthConfig(env)).toEqual({ mode: 'none' })
  })

  test('an unknown mode is refused, naming the value it got', () => {
    expect(() => parseAuthConfig({ AUTH_MODE: 'Password' })).toThrow(/"Password"/)
  })

  test('password mode reads the hash from AUTH_PASSWORD_HASH', async () => {
    const hash = await hashPassword('pw')

    expect(parseAuthConfig({ AUTH_MODE: 'password', AUTH_PASSWORD_HASH: hash })).toEqual({ mode: 'password', passwordHash: hash })
  })

  test('password mode without a hash names the script that writes one', () => {
    expect(() => parseAuthConfig({ AUTH_MODE: 'password' })).toThrow(/set-password/)
  })

  test('a plain password in AUTH_PASSWORD_HASH is refused', () => {
    expect(() => parseAuthConfig({ AUTH_MODE: 'password', AUTH_PASSWORD_HASH: 'hunter2' })).toThrow(AuthConfigError)
  })

  test('oidc mode trims the issuer, lower-cases the email and adds the openid scope', () => {
    const config = parseAuthConfig({ ...OIDC_BASE, OIDC_SCOPES: 'email profile' })

    expect(config).toEqual({
      mode: 'oidc',
      issuer: 'https://issuer.example.test',
      clientId: 'tracker-client',
      redirectUri: 'http://localhost:3000/auth/oidc/callback',
      scopes: ['openid', 'email', 'profile'],
      allowedEmail: 'person@example.test',
    })
  })

  test('oidc mode with neither an allowed subject nor an allowed email is refused', () => {
    const { OIDC_ALLOWED_EMAIL: _dropped, ...env } = OIDC_BASE

    expect(() => parseAuthConfig(env)).toThrow(/OIDC_ALLOWED_SUBJECT or OIDC_ALLOWED_EMAIL/)
  })

  test.each(['OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_REDIRECT_URI'])('oidc mode without %s names it', (name) => {
    const env: Record<string, string> = { ...OIDC_BASE }
    delete env[name]

    expect(() => parseAuthConfig(env)).toThrow(new RegExp(name))
  })

  test('a redirect URI that is not an absolute URL is refused', () => {
    expect(() => parseAuthConfig({ ...OIDC_BASE, OIDC_REDIRECT_URI: '/auth/oidc/callback' })).toThrow(/OIDC_REDIRECT_URI/)
  })
})
