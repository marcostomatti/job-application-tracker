import { describe, expect, test } from 'bun:test'

import { hashPassword, isPasswordHash, verifyPassword } from '../../src/auth/password-hash.ts'

describe('hashPassword and verifyPassword', () => {
  test('a hash verifies the password it was made from, and no other', async () => {
    // Arrange
    const hash = await hashPassword('correct horse battery staple')

    // Act
    const right = await verifyPassword('correct horse battery staple', hash)
    const wrong = await verifyPassword('correct horse battery stapler', hash)

    // Assert
    expect(right).toBe(true)
    expect(wrong).toBe(false)
  })

  test('two hashes of one password differ, because each has its own salt', async () => {
    const first = await hashPassword('same')
    const second = await hashPassword('same')

    expect(first).not.toBe(second)
  })

  test('a hash holds no `$`, so a dotenv loader that expands variables leaves it whole', async () => {
    const hash = await hashPassword('anything')

    expect(hash).not.toContain('$')
    expect(/\s/.test(hash)).toBe(false)
    expect(isPasswordHash(hash)).toBe(true)
  })

  test.each(['', 'plain-text-password', 'scrypt.only-one-part', 'scrypt.a.b.c'])(
    'a malformed stored value %p verifies nothing and does not throw',
    async (stored) => {
      expect(isPasswordHash(stored)).toBe(false)
      expect(await verifyPassword('plain-text-password', stored)).toBe(false)
    },
  )

  test('an empty password is refused at hashing', async () => {
    await expect(hashPassword('')).rejects.toThrow(/empty/)
  })
})
