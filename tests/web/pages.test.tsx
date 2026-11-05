import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import { ApiError, request } from '../../src/web/api.ts'
import { pageFor, PAGES } from '../../src/web/app.tsx'
import { LoginPage } from '../../src/web/pages/login.tsx'
import { TokensPage } from '../../src/web/pages/tokens.tsx'

const noop = (): void => {}

describe('LoginPage', () => {
  test('password mode shows a password field and points at reset-credentials', () => {
    const html = renderToStaticMarkup(<LoginPage mode="password" onSignedIn={noop} />)

    expect(html).toContain('type="password"')
    expect(html).toContain('bun run reset-credentials')
  })

  test('oidc mode links to the start route, and shows a refusal when the callback sent one', () => {
    const plain = renderToStaticMarkup(<LoginPage mode="oidc" onSignedIn={noop} />)
    const refused = renderToStaticMarkup(<LoginPage mode="oidc" oidcError onSignedIn={noop} />)

    expect(plain).toContain('href="/auth/oidc/start"')
    expect(plain).not.toContain('role="alert"')
    expect(refused).toContain('role="alert"')
  })

  test('with no mode it says sign-in is off and shows no form', () => {
    const html = renderToStaticMarkup(<LoginPage mode="none" onSignedIn={noop} />)

    expect(html).toContain('No login is configured')
    expect(html).not.toContain('<form')
  })
})

describe('TokensPage', () => {
  test('lists each token by name and prefix, never a whole token, and marks a revoked one', () => {
    const html = renderToStaticMarkup(
      <TokensPage
        initial={[
          { id: 1, name: 'research agent', prefix: 'jat_abcd', createdAt: '2026-01-02T10:00:00Z', lastUsedAt: null, revokedAt: null },
          { id: 2, name: 'old laptop', prefix: 'jat_wxyz', createdAt: '2026-01-01T10:00:00Z', lastUsedAt: null, revokedAt: '2026-01-03T10:00:00Z' },
        ]}
      />,
    )

    expect(html).toContain('research agent')
    expect(html).toContain('jat_abcd…')
    expect(html).toContain('class="revoked"')
    expect(html.match(/>Revoke</g)?.length).toBe(1)
  })

  test('with no tokens it says so', () => {
    expect(renderToStaticMarkup(<TokensPage />)).toContain('No tokens yet.')
  })
})

describe('the page table', () => {
  test('an unknown path and / land on the first page', () => {
    expect(pageFor('/').path).toBe(PAGES[0]?.path ?? '')
    expect(pageFor('/nowhere').path).toBe(PAGES[0]?.path ?? '')
  })
})

describe('request', () => {
  function answering(status: number, body: unknown): typeof fetch {
    return Object.assign(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }), {
      preconnect: fetch.preconnect,
    })
  }

  test('returns data from a success envelope', async () => {
    expect(await request('GET', '/x', undefined, answering(200, { success: true, data: 7 }))).toBe(7)
  })

  test("throws the envelope's name and message, and copes with a string error or no JSON", async () => {
    const enveloped = await request('GET', '/x', undefined, answering(401, { success: false, error: { name: 'Unauthorized', message: 'sign in first' } })).catch((e: unknown) => e)
    const stringy = await request('GET', '/x', undefined, answering(413, { error: 'too large' })).catch((e: unknown) => e)
    const html = await request('GET', '/x', undefined, answering(429, 'slow down')).catch((e: unknown) => e)

    expect(enveloped).toMatchObject({ status: 401, errorName: 'Unauthorized', message: 'sign in first' })
    expect(stringy).toBeInstanceOf(ApiError)
    expect((html as ApiError).message).toContain('429')
  })

  test('a write carries the CSRF header and a read does not', async () => {
    const seen: Headers[] = []
    const recording = Object.assign(
      async (_url: unknown, init?: RequestInit) => {
        seen.push(new Headers(init?.headers))
        return Response.json({ success: true, data: null })
      },
      { preconnect: fetch.preconnect },
    ) as typeof fetch

    await request('GET', '/x', undefined, recording)
    await request('POST', '/x', {}, recording)

    expect(seen[0]?.get('x-jat-csrf')).toBeNull()
    expect(seen[1]?.get('x-jat-csrf')).toBe('1')
  })
})
