import { describe, expect, test } from 'bun:test'

import { generateApiKey } from '../../src/auth/api-key.ts'
import {
  burnAfterReading,
  CLEAR_SCREEN_AND_SCROLLBACK,
  main,
  writeKeyToEnvFile,
  type MainIo,
} from '../../src/auth/set-api-key.ts'

/** Keys are generated at run time, so no key-shaped literal sits in the repository. */
const OLD_KEY = generateApiKey()
const NEW_KEY = generateApiKey()

describe('writeKeyToEnvFile', () => {
  test('writeKeyToEnvFile replaces an existing API_KEY line and keeps the rest', () => {
    const before = `DATABASE_URL=placeholder\nAPI_KEY=${OLD_KEY}\nDB_PORT=5439\n`

    expect(writeKeyToEnvFile(before, NEW_KEY)).toBe(
      `DATABASE_URL=placeholder\nAPI_KEY=${NEW_KEY}\nDB_PORT=5439\n`,
    )
  })

  test('writeKeyToEnvFile appends when no API_KEY line exists', () => {
    const before = 'DATABASE_URL=placeholder\nDB_PORT=5439\n'

    expect(writeKeyToEnvFile(before, NEW_KEY)).toBe(
      `DATABASE_URL=placeholder\nDB_PORT=5439\nAPI_KEY=${NEW_KEY}\n`,
    )
  })

  test('writeKeyToEnvFile does not duplicate a commented API_KEY line', () => {
    const before = 'DATABASE_URL=placeholder\n# API_KEY=\n'

    const after = writeKeyToEnvFile(before, NEW_KEY)

    const activeLines = after.split('\n').filter((line) => line.startsWith('API_KEY='))
    expect(activeLines).toEqual([`API_KEY=${NEW_KEY}`])
    expect(after).toContain('# API_KEY=\n')
  })

  test('writeKeyToEnvFile replaces a line that carries a trailing comment', () => {
    const before = `API_KEY=${OLD_KEY} # rotate monthly\nDB_PORT=5439\n`

    expect(writeKeyToEnvFile(before, NEW_KEY)).toBe(`API_KEY=${NEW_KEY}\nDB_PORT=5439\n`)
  })

  test('writeKeyToEnvFile replaces every API_KEY line so a later duplicate cannot win', () => {
    const before = `API_KEY=${OLD_KEY}\nDB_PORT=5439\nAPI_KEY=${OLD_KEY}\n`

    expect(writeKeyToEnvFile(before, NEW_KEY)).toBe(
      `API_KEY=${NEW_KEY}\nDB_PORT=5439\nAPI_KEY=${NEW_KEY}\n`,
    )
  })

  test('writeKeyToEnvFile fills an empty file with the one line', () => {
    expect(writeKeyToEnvFile('', NEW_KEY)).toBe(`API_KEY=${NEW_KEY}\n`)
  })

  test('writeKeyToEnvFile ends the previous last line before appending when the file has no trailing newline', () => {
    expect(writeKeyToEnvFile('DB_PORT=5439', NEW_KEY)).toBe(`DB_PORT=5439\nAPI_KEY=${NEW_KEY}\n`)
  })

  test('writeKeyToEnvFile keeps CRLF line endings when replacing', () => {
    const before = `DB_PORT=5439\r\nAPI_KEY=${OLD_KEY}\r\nOTHER=1\r\n`

    expect(writeKeyToEnvFile(before, NEW_KEY)).toBe(
      `DB_PORT=5439\r\nAPI_KEY=${NEW_KEY}\r\nOTHER=1\r\n`,
    )
  })

  test('writeKeyToEnvFile keeps CRLF line endings when appending', () => {
    expect(writeKeyToEnvFile('DB_PORT=5439\r\n', NEW_KEY)).toBe(
      `DB_PORT=5439\r\nAPI_KEY=${NEW_KEY}\r\n`,
    )
  })

  test('writeKeyToEnvFile refuses a key that would break out of its line', () => {
    expect(() => writeKeyToEnvFile('', `${NEW_KEY}\nEVIL=1`)).toThrow()
    expect(() => writeKeyToEnvFile('', '')).toThrow()
  })
})

/** Records each side effect in the order it happens. */
function recordingSideEffects() {
  const events: string[] = []
  const printed: string[] = []
  return {
    events,
    printed,
    write: (text: string) => {
      printed.push(text)
      events.push('write')
    },
    clear: () => {
      events.push('clear')
    },
    wait: async (ms: number) => {
      events.push(`wait:${ms}`)
    },
  }
}

describe('burnAfterReading', () => {
  test('burnAfterReading prints, waits, then clears, in that order', async () => {
    const effects = recordingSideEffects()

    await burnAfterReading({ key: NEW_KEY, seconds: 7, ...effects })

    expect(effects.events).toEqual(['write', 'wait:7000', 'clear'])
  })

  test('burnAfterReading prints the key itself', async () => {
    const effects = recordingSideEffects()

    await burnAfterReading({ key: NEW_KEY, seconds: 1, ...effects })

    expect(effects.printed.join('')).toContain(NEW_KEY)
  })

  test('the printed text tells the reader to read it immediately', async () => {
    const effects = recordingSideEffects()

    await burnAfterReading({ key: NEW_KEY, seconds: 30, ...effects })

    expect(effects.printed.join('')).toMatch(/read .*(now|immediately)/i)
  })

  test('the printed text names cat .env as the recovery path', async () => {
    const effects = recordingSideEffects()

    await burnAfterReading({ key: NEW_KEY, seconds: 30, ...effects })

    expect(effects.printed.join('')).toContain('cat .env')
  })

  test('the printed text says how long the key stays on screen', async () => {
    const effects = recordingSideEffects()

    await burnAfterReading({ key: NEW_KEY, seconds: 12, ...effects })

    expect(effects.printed.join('')).toContain('12 seconds')
  })

  test('still clears the screen when the wait rejects', async () => {
    const effects = recordingSideEffects()
    const failingWait = async () => {
      throw new Error('interrupted')
    }

    await expect(
      burnAfterReading({ key: NEW_KEY, seconds: 5, ...effects, wait: failingWait }),
    ).rejects.toThrow('interrupted')
    expect(effects.events).toEqual(['write', 'clear'])
  })
})

/** An in-memory stand-in for the terminal and the `.env` file: no real file is touched. */
function fakeIo(initialFile: string | null, options: { failWrite?: boolean } = {}) {
  const events: string[] = []
  const stdout: string[] = []
  const stderr: string[] = []
  const state = { file: initialFile, filePath: '' }
  const io: MainIo = {
    envPath: '/virtual/.env',
    readFile: async (path) => {
      state.filePath = path
      return state.file
    },
    writeFile: async (path, text) => {
      if (options.failWrite) throw new Error('read-only file system')
      state.filePath = path
      state.file = text
      events.push('file')
    },
    write: (text) => {
      stdout.push(text)
      events.push('write')
    },
    writeError: (text) => {
      stderr.push(text)
    },
    clear: () => {
      events.push('clear')
    },
    wait: async () => {
      events.push('wait')
    },
  }
  return { io, events, stdout, stderr, state }
}

describe('main', () => {
  test('main without --burn-after-reading explains the flag and exits non-zero', async () => {
    const fake = fakeIo(`DB_PORT=5439\n`)

    const code = await main([], fake.io)

    expect(code).not.toBe(0)
    expect(fake.stderr.join('')).toContain('--burn-after-reading')
    expect(fake.stdout).toEqual([])
    expect(fake.state.file).toBe('DB_PORT=5439\n')
    expect(fake.events).toEqual([])
  })

  test('main creates the file content when .env does not exist yet, saves it, then shows the key', async () => {
    const fake = fakeIo(null)

    const code = await main(['--burn-after-reading'], fake.io)

    expect(code).toBe(0)
    expect(fake.state.file).toMatch(/^API_KEY=jat_[A-Za-z0-9_-]{43}\n$/)
    const savedKey = fake.state.file!.slice('API_KEY='.length).trim()
    expect(fake.stdout.join('')).toContain(savedKey)
    expect(fake.events).toEqual(['file', 'write', 'wait', 'clear'])
  })

  test('main replaces an API_KEY that is already set and leaves the other lines alone', async () => {
    const fake = fakeIo(`DATABASE_URL=placeholder\nAPI_KEY=${OLD_KEY}\nDB_PORT=5439\n`)

    const code = await main(['--burn-after-reading'], fake.io)

    expect(code).toBe(0)
    expect(fake.state.file).not.toContain(OLD_KEY)
    expect(fake.state.file).toMatch(
      /^DATABASE_URL=placeholder\nAPI_KEY=jat_[A-Za-z0-9_-]{43}\nDB_PORT=5439\n$/,
    )
    expect(fake.stdout.join('')).not.toContain(OLD_KEY)
  })

  test('main shows nothing and exits non-zero when the file cannot be written', async () => {
    const fake = fakeIo(`DB_PORT=5439\n`, { failWrite: true })

    const code = await main(['--burn-after-reading'], fake.io)

    expect(code).not.toBe(0)
    expect(fake.stdout).toEqual([])
    expect(fake.events).toEqual([])
    expect(fake.stderr.join('')).toContain('read-only file system')
  })

  test('main reads and writes the path it was given, not another', async () => {
    const fake = fakeIo(null)

    await main(['--burn-after-reading'], fake.io)

    expect(fake.state.filePath).toBe('/virtual/.env')
  })
})

describe('CLEAR_SCREEN_AND_SCROLLBACK', () => {
  test('clears the screen and the scrollback, then homes the cursor', () => {
    expect(CLEAR_SCREEN_AND_SCROLLBACK).toBe('\x1b[2J\x1b[3J\x1b[H')
  })
})
