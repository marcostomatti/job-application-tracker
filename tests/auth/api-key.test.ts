import { describe, expect, test } from 'bun:test'

import { GENERATED_KEY_LENGTH, generateApiKey, verifyApiKey } from '../../src/auth/api-key.ts'

/** A stand-in secret built at run time, so no key-shaped literal sits in the repository. */
const EXPECTED = 'stand-in-secret-'.concat('a'.repeat(24))

describe('generateApiKey', () => {
  test('generateApiKey returns a prefixed key and never repeats', () => {
    const keys = new Set(Array.from({ length: 100 }, generateApiKey))

    expect(keys.size).toBe(100)
    expect([...keys].every((key) => key.startsWith('jat_'))).toBe(true)
  })

  test('generateApiKey encodes 32 bytes as unpadded base64url after the prefix', () => {
    const key = generateApiKey()
    const body = key.slice('jat_'.length)

    expect(body).toMatch(/^[A-Za-z0-9_-]+$/)
    // 32 bytes is 43 base64url characters without padding.
    expect(body).toHaveLength(43)
    expect(Buffer.from(body, 'base64url')).toHaveLength(32)
  })

  test('GENERATED_KEY_LENGTH is the length of a generated key', () => {
    expect(generateApiKey()).toHaveLength(GENERATED_KEY_LENGTH)
  })
})

describe('verifyApiKey', () => {
  test('verifyApiKey accepts the same key and rejects a different one', () => {
    expect(verifyApiKey(EXPECTED, EXPECTED)).toBe(true)
    expect(verifyApiKey(`${EXPECTED}x`.slice(1), EXPECTED)).toBe(false)
    expect(verifyApiKey(generateApiKey(), EXPECTED)).toBe(false)
  })

  test('verifyApiKey rejects a key that is a prefix of the expected one', () => {
    expect(verifyApiKey(EXPECTED.slice(0, -1), EXPECTED)).toBe(false)
    expect(verifyApiKey(EXPECTED.slice(0, 4), EXPECTED)).toBe(false)
  })

  test('verifyApiKey rejects a key that extends the expected one', () => {
    expect(verifyApiKey(`${EXPECTED}0`, EXPECTED)).toBe(false)
  })

  test('verifyApiKey rejects an empty presented key', () => {
    expect(verifyApiKey('', EXPECTED)).toBe(false)
  })

  test('verifyApiKey returns false instead of throwing when the lengths differ', () => {
    expect(() => verifyApiKey('x', EXPECTED)).not.toThrow()
    expect(() => verifyApiKey(EXPECTED.repeat(50), EXPECTED)).not.toThrow()
    expect(verifyApiKey(EXPECTED.repeat(50), EXPECTED)).toBe(false)
  })

  test('verifyApiKey rejects everything when the expected key is empty', () => {
    expect(verifyApiKey('', '')).toBe(false)
    expect(verifyApiKey('anything', '')).toBe(false)
  })
})
