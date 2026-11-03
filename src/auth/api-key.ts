import { createHash, timingSafeEqual } from 'node:crypto'

/** What every generated key starts with, so a key is recognisable in a config file or a leak scan. */
const KEY_PREFIX = 'jat_'

/** The random bytes in a key: 256 bits, past any online or offline guessing. */
const KEY_BYTES = 32

/**
 * A new API key: 32 bytes from the platform's cryptographic generator, base64url-encoded
 * (URL and header safe, no padding) behind the `jat_` prefix. The caller stores it; this
 * module keeps and logs nothing.
 */
export function generateApiKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(KEY_BYTES))
  return `${KEY_PREFIX}${Buffer.from(bytes).toString('base64url')}`
}

/** SHA-256 of a string: always 32 bytes, whatever the input's length. */
function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

/**
 * Whether `presented` is the key `expected`, compared as SHA-256 digests.
 *
 * `timingSafeEqual` throws when its inputs differ in length, so comparing the raw strings
 * would throw on a wrong-length key and reveal the expected length through the throw. Both
 * digests are 32 bytes, so the comparison always runs, takes the same time whatever was
 * presented, and says nothing about length. There is deliberately no early return before
 * the hash: not on a length mismatch, not on an empty `presented`.
 *
 * An empty `expected` matches nothing, not even an empty `presented`. That test runs after
 * the comparison and looks only at the configured key, so it leaks nothing about it. It is a
 * second guard behind `requireApiKey`'s own refusal of an unset key, because the digests of
 * two empty strings are equal and a caller that skipped that guard would otherwise be open.
 */
export function verifyApiKey(presented: string, expected: string): boolean {
  const digestsMatch = timingSafeEqual(digest(presented), digest(expected))
  return digestsMatch && expected.length > 0
}
