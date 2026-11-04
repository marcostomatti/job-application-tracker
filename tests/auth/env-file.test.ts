import { describe, expect, test } from 'bun:test'

import { readEnvValue, removeEnvValue, setEnvValue } from '../../src/auth/env-file.ts'

describe('setEnvValue', () => {
  test('appends to a file without the name, and to an empty file', () => {
    expect(setEnvValue('DATABASE_URL=x\n', 'AUTH_PASSWORD_HASH', 'scrypt.a.b')).toBe('DATABASE_URL=x\nAUTH_PASSWORD_HASH=scrypt.a.b\n')
    expect(setEnvValue('A=1', 'B', '2')).toBe('A=1\nB=2\n')
    expect(setEnvValue('', 'B', '2')).toBe('B=2\n')
  })

  test('replaces every active line, keeps commented lines and CRLF endings', () => {
    const current = '# B=old-comment\r\nB=one\r\nexport B=two\r\n'

    expect(setEnvValue(current, 'B', 'new')).toBe('# B=old-comment\r\nB=new\r\nB=new\r\n')
  })

  test('refuses a value that a dotenv loader would split or expand', () => {
    for (const bad of ['', 'a b', 'a#b', 'a$b', '"a"']) expect(() => setEnvValue('', 'B', bad)).toThrow()
  })

  test('does not touch a longer name that starts the same', () => {
    expect(setEnvValue('BB=1\n', 'B', '2')).toBe('BB=1\nB=2\n')
  })
})

describe('removeEnvValue', () => {
  test('removes active lines only, and says whether it did', () => {
    expect(removeEnvValue('A=1\nB=2\n# B=3\n', 'B')).toEqual({ text: 'A=1\n# B=3\n', removed: true })
    expect(removeEnvValue('A=1\n', 'B')).toEqual({ text: 'A=1\n', removed: false })
  })
})

describe('readEnvValue', () => {
  test('reads the last active value, unquoted, without a trailing comment', () => {
    expect(readEnvValue('AUTH_MODE=oidc\nAUTH_MODE="password" # chosen\n', 'AUTH_MODE')).toBe('password')
    expect(readEnvValue('# AUTH_MODE=oidc\n', 'AUTH_MODE')).toBeUndefined()
  })
})
