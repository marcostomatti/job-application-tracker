import { describe, expect, test } from 'bun:test'

import { bearerCredentialOf } from '../../src/auth/access.ts'
import { createToken, revokeToken } from '../../src/auth/store.ts'
import { useSharedScratchDatabase } from '../mcp/tools/harness.ts'

const database = useSharedScratchDatabase()

const API_KEY = 'k'.repeat(48)

describe('bearerCredentialOf', () => {
  test('the configured API key is an api-key credential', async () => {
    expect(await bearerCredentialOf(`Bearer ${API_KEY}`, database(), API_KEY)).toBe('api-key')
  })

  test('a minted, unrevoked token is an api-token credential', async () => {
    const { token } = await createToken(database(), 'an mcp client')

    expect(await bearerCredentialOf(`Bearer ${token}`, database(), API_KEY)).toBe('api-token')
  })

  test('a minted token works when no API key is configured', async () => {
    const { token } = await createToken(database(), 'no key configured')

    expect(await bearerCredentialOf(`Bearer ${token}`, database(), undefined)).toBe('api-token')
  })

  test('a revoked token opens nothing', async () => {
    const { token, summary } = await createToken(database(), 'revoked client')
    await revokeToken(database(), summary.id)

    expect(await bearerCredentialOf(`Bearer ${token}`, database(), API_KEY)).toBeUndefined()
  })

  test('a wrong bearer opens nothing', async () => {
    expect(await bearerCredentialOf('Bearer not-a-known-token', database(), API_KEY)).toBeUndefined()
  })

  test('an empty configured key never matches an empty-looking bearer', async () => {
    expect(await bearerCredentialOf('Bearer x', database(), '')).toBeUndefined()
  })

  test('no header, or a malformed one, opens nothing', async () => {
    for (const header of [undefined, '', API_KEY, `Basic ${API_KEY}`, `Bearer  ${API_KEY}`, ['Bearer a', 'Bearer b']]) {
      expect(await bearerCredentialOf(header, database(), API_KEY)).toBeUndefined()
    }
  })
})
