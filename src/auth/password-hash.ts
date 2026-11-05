import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

/** What every stored hash starts with, so a plain password pasted into `.env` is recognised as not a hash. */
const HASH_PREFIX = 'scrypt'

const SALT_BYTES = 16
const KEY_BYTES = 32

/** scrypt's cost settings: N=2^15 takes about 50 ms here, slow enough for guessing and quick for one login. */
const SCRYPT_OPTIONS = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const

/**
 * `scrypt.<salt>.<key>`, both base64url. The separator is a dot and not the usual `$`, because
 * Bun's `.env` loader expands `$NAME` inside values and would cut a `$`-separated hash apart.
 */
const HASH_SHAPE = /^scrypt\.([A-Za-z0-9_-]{16,})\.([A-Za-z0-9_-]{32,})$/

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_BYTES, SCRYPT_OPTIONS, (error, key) => (error ? reject(error) : resolve(key)))
  })
}

/** Whether a stored value has the shape `hashPassword` writes. */
export function isPasswordHash(stored: string): boolean {
  return HASH_SHAPE.test(stored)
}

/** A salted scrypt hash of `password`, in the form `AUTH_PASSWORD_HASH` holds. */
export async function hashPassword(password: string): Promise<string> {
  if (password.length === 0) throw new Error('The password must not be empty.')
  const salt = randomBytes(SALT_BYTES)
  const key = await derive(password, salt)
  return `${HASH_PREFIX}.${salt.toString('base64url')}.${key.toString('base64url')}`
}

/** Whether `password` is the one `stored` was made from. A malformed `stored` matches nothing. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = HASH_SHAPE.exec(stored)
  if (!parts?.[1] || !parts[2]) return false
  const expected = Buffer.from(parts[2], 'base64url')
  const actual = await derive(password, Buffer.from(parts[1], 'base64url'))
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}
