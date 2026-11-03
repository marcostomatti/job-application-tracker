import { EventEmitter } from 'node:events'
import { afterAll, describe, expect, test } from 'bun:test'
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { generateApiKey } from '../../src/auth/api-key.ts'
import {
  burnAfterReading,
  CLEAR_SCREEN_AND_SCROLLBACK,
  createRealIo,
  hasApiKeyLine,
  main,
  registerInterrupt,
  replaceApiKeyLine,
  type MainIo,
} from '../../src/auth/set-api-key.ts'

/** Keys are generated at run time, so no key-shaped literal sits in the repository. */
const OLD_KEY = generateApiKey()
const NEW_KEY = generateApiKey()

/** The shape of a generated key, sized from the generator so a change of key size fails nothing here. */
const KEY_SHAPE = `jat_[A-Za-z0-9_-]{${generateApiKey().length - 'jat_'.length}}`

const REPLACED_WARNING = 'any client using the old key must be updated'

describe('replaceApiKeyLine', () => {
  test('replaceApiKeyLine replaces an existing API_KEY line and keeps the rest', () => {
    const before = `DATABASE_URL=placeholder\nAPI_KEY=${OLD_KEY}\nDB_PORT=5439\n`

    expect(replaceApiKeyLine(before, NEW_KEY)).toBe(
      `DATABASE_URL=placeholder\nAPI_KEY=${NEW_KEY}\nDB_PORT=5439\n`,
    )
  })

  test('replaceApiKeyLine appends when no API_KEY line exists', () => {
    const before = 'DATABASE_URL=placeholder\nDB_PORT=5439\n'

    expect(replaceApiKeyLine(before, NEW_KEY)).toBe(
      `DATABASE_URL=placeholder\nDB_PORT=5439\nAPI_KEY=${NEW_KEY}\n`,
    )
  })

  test('replaceApiKeyLine does not duplicate a commented API_KEY line', () => {
    const before = 'DATABASE_URL=placeholder\n# API_KEY=\n'

    const after = replaceApiKeyLine(before, NEW_KEY)

    const activeLines = after.split('\n').filter((line) => line.startsWith('API_KEY='))
    expect(activeLines).toEqual([`API_KEY=${NEW_KEY}`])
    expect(after).toContain('# API_KEY=\n')
  })

  test('replaceApiKeyLine keeps the trailing comment on the line it replaces', () => {
    const before = `API_KEY=${OLD_KEY} # used by the importer\nDB_PORT=5439\n`

    expect(replaceApiKeyLine(before, NEW_KEY)).toBe(
      `API_KEY=${NEW_KEY} # used by the importer\nDB_PORT=5439\n`,
    )
  })

  test('replaceApiKeyLine keeps a trailing comment on a CRLF line and its spacing', () => {
    const before = `API_KEY=${OLD_KEY}\t#  note # more\r\nDB_PORT=5439\r\n`

    expect(replaceApiKeyLine(before, NEW_KEY)).toBe(
      `API_KEY=${NEW_KEY}\t#  note # more\r\nDB_PORT=5439\r\n`,
    )
  })

  test('replaceApiKeyLine keeps the comment when the old value was empty', () => {
    expect(replaceApiKeyLine('API_KEY= # fill me\n', NEW_KEY)).toBe(`API_KEY=${NEW_KEY} # fill me\n`)
  })

  test('replaceApiKeyLine keeps a comment on the last line when the file has no trailing newline', () => {
    expect(replaceApiKeyLine(`API_KEY=${OLD_KEY} # last`, NEW_KEY)).toBe(`API_KEY=${NEW_KEY} # last`)
  })

  test('replaceApiKeyLine replaces every API_KEY line so a later duplicate cannot win', () => {
    const before = `API_KEY=${OLD_KEY}\nDB_PORT=5439\nAPI_KEY=${OLD_KEY}\n`

    expect(replaceApiKeyLine(before, NEW_KEY)).toBe(
      `API_KEY=${NEW_KEY}\nDB_PORT=5439\nAPI_KEY=${NEW_KEY}\n`,
    )
  })

  test('replaceApiKeyLine fills an empty file with the one line', () => {
    expect(replaceApiKeyLine('', NEW_KEY)).toBe(`API_KEY=${NEW_KEY}\n`)
  })

  test('replaceApiKeyLine ends the previous last line before appending when the file has no trailing newline', () => {
    expect(replaceApiKeyLine('DB_PORT=5439', NEW_KEY)).toBe(`DB_PORT=5439\nAPI_KEY=${NEW_KEY}\n`)
  })

  test('replaceApiKeyLine keeps CRLF line endings when replacing', () => {
    const before = `DB_PORT=5439\r\nAPI_KEY=${OLD_KEY}\r\nOTHER=1\r\n`

    expect(replaceApiKeyLine(before, NEW_KEY)).toBe(
      `DB_PORT=5439\r\nAPI_KEY=${NEW_KEY}\r\nOTHER=1\r\n`,
    )
  })

  test('replaceApiKeyLine keeps CRLF line endings when appending', () => {
    expect(replaceApiKeyLine('DB_PORT=5439\r\n', NEW_KEY)).toBe(
      `DB_PORT=5439\r\nAPI_KEY=${NEW_KEY}\r\n`,
    )
  })

  test('replaceApiKeyLine replaces an indented API_KEY line in place instead of appending a second one', () => {
    const before = `DB_PORT=5439\n  API_KEY=${OLD_KEY}\n\tAPI_KEY=${OLD_KEY}\n`

    const after = replaceApiKeyLine(before, NEW_KEY)

    expect(after).toBe(`DB_PORT=5439\n  API_KEY=${NEW_KEY}\n\tAPI_KEY=${NEW_KEY}\n`)
    expect(after).not.toContain(OLD_KEY)
  })

  test('replaceApiKeyLine replaces an export-prefixed API_KEY line and keeps the prefix and comment', () => {
    const before = `export API_KEY=${OLD_KEY} # shell style\nDB_PORT=5439\n  export   API_KEY=${OLD_KEY}\n`

    expect(replaceApiKeyLine(before, NEW_KEY)).toBe(
      `export API_KEY=${NEW_KEY} # shell style\nDB_PORT=5439\n  export   API_KEY=${NEW_KEY}\n`,
    )
  })

  test('replaceApiKeyLine leaves a variable that only ends in API_KEY alone and appends', () => {
    const before = 'MY_API_KEY=other\nexportAPI_KEY=other\n'

    expect(replaceApiKeyLine(before, NEW_KEY)).toBe(`${before}API_KEY=${NEW_KEY}\n`)
  })

  test('replaceApiKeyLine does not split a quoted value at a hash inside the quotes', () => {
    expect(replaceApiKeyLine('API_KEY="a # b"\nDB_PORT=5439\n', NEW_KEY)).toBe(
      `API_KEY=${NEW_KEY}\nDB_PORT=5439\n`,
    )
    expect(replaceApiKeyLine("API_KEY='a # b'\n", NEW_KEY)).toBe(`API_KEY=${NEW_KEY}\n`)
  })

  test('replaceApiKeyLine keeps the comment that follows a quoted value', () => {
    expect(replaceApiKeyLine('API_KEY="a # b" # the real note\n', NEW_KEY)).toBe(
      `API_KEY=${NEW_KEY} # the real note\n`,
    )
  })

  test('replaceApiKeyLine replaces an unterminated quoted value whole, leaving no stray fragment', () => {
    expect(replaceApiKeyLine('API_KEY="a # b\n', NEW_KEY)).toBe(`API_KEY=${NEW_KEY}\n`)
  })

  test('replaceApiKeyLine refuses a key that would break out of its line', () => {
    expect(() => replaceApiKeyLine('', `${NEW_KEY}\nEVIL=1`)).toThrow()
    expect(() => replaceApiKeyLine('', '')).toThrow()
  })
})

/** Records each side effect in the order it happens, and lets a test play the part of a signal. */
function recordingSideEffects() {
  const events: string[] = []
  const printed: string[] = []
  const handlers = new Set<() => void>()
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
    onInterrupt: (handler: () => void) => {
      events.push('register')
      handlers.add(handler)
      return () => {
        events.push('unregister')
        handlers.delete(handler)
      }
    },
    /** Deliver a signal to whoever is registered right now. */
    signal: () => {
      for (const handler of [...handlers]) handler()
    },
    activeHandlerCount: () => handlers.size,
  }
}

describe('hasApiKeyLine', () => {
  test('hasApiKeyLine is true only for an active API_KEY line', () => {
    expect(hasApiKeyLine(`DB_PORT=5439\nAPI_KEY=${OLD_KEY}\n`)).toBe(true)
    expect(hasApiKeyLine(`API_KEY=${OLD_KEY}\r\n`)).toBe(true)
    expect(hasApiKeyLine(`  API_KEY=${OLD_KEY}\n`)).toBe(true)
    expect(hasApiKeyLine(`export API_KEY=${OLD_KEY}\n`)).toBe(true)
    expect(hasApiKeyLine('# API_KEY=\nDB_PORT=5439\n')).toBe(false)
    expect(hasApiKeyLine('MY_API_KEY=x\n')).toBe(false)
    expect(hasApiKeyLine('')).toBe(false)
  })
})

describe('burnAfterReading', () => {
  test('burnAfterReading prints, waits, then clears, in that order', async () => {
    const effects = recordingSideEffects()

    await burnAfterReading({ key: NEW_KEY, seconds: 7, ...effects })

    expect(effects.events).toEqual(['register', 'write', 'wait:7000', 'clear', 'unregister'])
  })

  test('burnAfterReading listens for an interrupt before the key is printed, and stops listening afterwards', async () => {
    const effects = recordingSideEffects()

    await burnAfterReading({ key: NEW_KEY, seconds: 1, ...effects })

    expect(effects.events.indexOf('register')).toBeLessThan(effects.events.indexOf('write'))
    expect(effects.activeHandlerCount()).toBe(0)
  })

  test('an interrupt during the wait clears the screen at once, without waiting out the timer', async () => {
    const effects = recordingSideEffects()
    let release: () => void = () => {}
    const pendingWait = new Promise<void>((resolve) => {
      release = resolve
    })
    const burning = burnAfterReading({
      key: NEW_KEY,
      seconds: 30,
      ...effects,
      wait: () => pendingWait,
    })

    effects.signal()

    // The wait has not finished, and the screen is already clear.
    expect(effects.events).toEqual(['register', 'write', 'clear'])
    release()
    await burning
    expect(effects.events.filter((event) => event === 'clear')).toHaveLength(1)
    expect(effects.activeHandlerCount()).toBe(0)
  })

  test('an interrupt on a replaced key still leaves the warning after the clear', async () => {
    const effects = recordingSideEffects()
    let release: () => void = () => {}
    const pendingWait = new Promise<void>((resolve) => {
      release = resolve
    })
    const burning = burnAfterReading({
      key: NEW_KEY,
      seconds: 30,
      replacedExisting: true,
      ...effects,
      wait: () => pendingWait,
    })

    effects.signal()
    release()
    await burning

    expect(effects.events).toEqual(['register', 'write', 'clear', 'write', 'unregister'])
    expect(effects.printed.at(-1)).toContain('update any client')
    expect(effects.printed.at(-1)).not.toContain(NEW_KEY)
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

  test('burnAfterReading warns that clients on the old key must be updated, only when a key was replaced', async () => {
    const replaced = recordingSideEffects()
    const created = recordingSideEffects()

    await burnAfterReading({ key: NEW_KEY, seconds: 1, replacedExisting: true, ...replaced })
    await burnAfterReading({ key: NEW_KEY, seconds: 1, ...created })

    expect(replaced.printed.join('')).toContain(REPLACED_WARNING)
    expect(created.printed.join('')).not.toContain(REPLACED_WARNING)
    expect(replaced.events).toEqual(['register', 'write', 'wait:1000', 'clear', 'write', 'unregister'])
  })

  test('still clears the screen when the wait rejects', async () => {
    const effects = recordingSideEffects()
    const failingWait = async () => {
      throw new Error('interrupted')
    }

    await expect(
      burnAfterReading({ key: NEW_KEY, seconds: 5, ...effects, wait: failingWait }),
    ).rejects.toThrow('interrupted')
    expect(effects.events).toEqual(['register', 'write', 'clear', 'unregister'])
    expect(effects.activeHandlerCount()).toBe(0)
  })
})

describe('registerInterrupt', () => {
  /** A stand-in for `process`: emitting a signal name runs the listeners, and exit is recorded. */
  function fakeProcess() {
    const emitter = new EventEmitter()
    const exits: number[] = []
    const target = {
      once: (signal: 'SIGINT' | 'SIGTERM', listener: () => void) => emitter.once(signal, listener),
      off: (signal: 'SIGINT' | 'SIGTERM', listener: () => void) => emitter.off(signal, listener),
      exit: (code: number) => {
        exits.push(code)
      },
    }
    return { emitter, exits, target }
  }

  test('SIGINT runs the handler, then exits 130', () => {
    const fake = fakeProcess()
    const calls: string[] = []
    registerInterrupt(() => calls.push('handler'), fake.target)

    fake.emitter.emit('SIGINT')

    expect(calls).toEqual(['handler'])
    expect(fake.exits).toEqual([130])
  })

  test('SIGTERM runs the handler, then exits 143', () => {
    const fake = fakeProcess()
    const calls: string[] = []
    registerInterrupt(() => calls.push('handler'), fake.target)

    fake.emitter.emit('SIGTERM')

    expect(calls).toEqual(['handler'])
    expect(fake.exits).toEqual([143])
  })

  test('the process still exits when the handler throws', () => {
    const fake = fakeProcess()
    registerInterrupt(() => {
      throw new Error('terminal gone')
    }, fake.target)

    expect(() => fake.emitter.emit('SIGINT')).toThrow('terminal gone')
    expect(fake.exits).toEqual([130])
  })

  test('the returned function removes both listeners, so no handler is left behind', () => {
    const fake = fakeProcess()
    const calls: string[] = []
    const stop = registerInterrupt(() => calls.push('handler'), fake.target)
    expect(fake.emitter.listenerCount('SIGINT')).toBe(1)
    expect(fake.emitter.listenerCount('SIGTERM')).toBe(1)

    stop()

    expect(fake.emitter.listenerCount('SIGINT')).toBe(0)
    expect(fake.emitter.listenerCount('SIGTERM')).toBe(0)
    fake.emitter.emit('SIGINT')
    expect(calls).toEqual([])
    expect(fake.exits).toEqual([])
  })
})

/** An in-memory stand-in for the terminal and the `.env` file: no real file is touched. */
function fakeIo(
  initialFile: string | null,
  options: { failWrite?: boolean; failRead?: boolean } = {},
) {
  const events: string[] = []
  const stdout: string[] = []
  const stderr: string[] = []
  const state = { file: initialFile, filePath: '' }
  const io: MainIo = {
    envPath: '/virtual/.env',
    readFile: async (path) => {
      if (options.failRead) throw new Error('permission denied while reading')
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
    onInterrupt: () => {
      events.push('register')
      return () => {
        events.push('unregister')
      }
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
    expect(fake.state.file).toMatch(new RegExp(`^API_KEY=${KEY_SHAPE}\\n$`))
    const savedKey = fake.state.file!.slice('API_KEY='.length).trim()
    expect(fake.stdout.join('')).toContain(savedKey)
    expect(fake.events).toEqual(['file', 'register', 'write', 'wait', 'clear', 'unregister'])
    expect(fake.stdout.join('')).not.toContain(REPLACED_WARNING)
  })

  test('main replaces an API_KEY that is already set and leaves the other lines alone', async () => {
    const fake = fakeIo(`DATABASE_URL=placeholder\nAPI_KEY=${OLD_KEY}\nDB_PORT=5439\n`)

    const code = await main(['--burn-after-reading'], fake.io)

    expect(code).toBe(0)
    expect(fake.state.file).not.toContain(OLD_KEY)
    expect(fake.state.file).toMatch(
      new RegExp(`^DATABASE_URL=placeholder\\nAPI_KEY=${KEY_SHAPE}\\nDB_PORT=5439\\n$`),
    )
    expect(fake.stdout.join('')).not.toContain(OLD_KEY)
    expect(fake.stdout.join('')).toContain(REPLACED_WARNING)
  })

  test('main replaces an indented or export-prefixed API_KEY instead of leaving the old line active', async () => {
    const fake = fakeIo(`export API_KEY=${OLD_KEY}\nDB_PORT=5439\n`)

    await main(['--burn-after-reading'], fake.io)

    expect(fake.state.file).not.toContain(OLD_KEY)
    expect(fake.state.file!.match(/API_KEY=/g)).toHaveLength(1)
    expect(fake.stdout.join('')).toContain(REPLACED_WARNING)
  })

  test('main writes the replacement warning after the clear, and the key never after it', async () => {
    const fake = fakeIo(`API_KEY=${OLD_KEY}\n`)

    await main(['--burn-after-reading'], fake.io)

    expect(fake.events).toEqual([
      'file',
      'register',
      'write',
      'wait',
      'clear',
      'write',
      'unregister',
    ])
    const [beforeClear, afterClear] = fake.stdout
    const savedKey = fake.state.file!.slice('API_KEY='.length).trim()
    expect(beforeClear).toContain(savedKey)
    expect(afterClear).toContain('update any client')
    expect(afterClear).not.toContain(savedKey)
    expect(afterClear).not.toContain(OLD_KEY)
  })

  test('main writes nothing after the clear when no key was replaced', async () => {
    const fake = fakeIo(null)

    await main(['--burn-after-reading'], fake.io)

    expect(fake.stdout).toHaveLength(1)
    expect(fake.events.at(-2)).toBe('clear')
  })

  test('main does not announce a replacement when only a commented API_KEY line exists', async () => {
    const fake = fakeIo('# API_KEY=\nDB_PORT=5439\n')

    await main(['--burn-after-reading'], fake.io)

    expect(fake.stdout.join('')).not.toContain(REPLACED_WARNING)
  })

  test('main shows nothing and exits non-zero when the file cannot be written', async () => {
    const fake = fakeIo(`DB_PORT=5439\n`, { failWrite: true })

    const code = await main(['--burn-after-reading'], fake.io)

    expect(code).not.toBe(0)
    expect(fake.stdout).toEqual([])
    expect(fake.events).toEqual([])
    expect(fake.stderr.join('')).toContain('read-only file system')
  })

  test('main shows nothing and exits non-zero when the file cannot be read, and writes nothing', async () => {
    const fake = fakeIo(`DB_PORT=5439\n`, { failRead: true })

    const code = await main(['--burn-after-reading'], fake.io)

    expect(code).not.toBe(0)
    expect(fake.stdout).toEqual([])
    expect(fake.events).toEqual([])
    expect(fake.state.file).toBe('DB_PORT=5439\n')
    expect(fake.stderr.join('')).toContain('permission denied while reading')
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

describe('createRealIo', () => {
  const scratch = mkdtemp(join(tmpdir(), 'set-api-key-test-'))
  afterAll(async () => {
    await rm(await scratch, { recursive: true, force: true })
  })

  /** A fresh, empty directory per test, under the system temp directory. */
  async function freshDir(): Promise<string> {
    const dir = join(await scratch, crypto.randomUUID())
    await mkdir(dir)
    return dir
  }

  test('readFile returns null for a file that does not exist', async () => {
    const dir = await freshDir()

    expect(await createRealIo(join(dir, '.env')).readFile(join(dir, '.env'))).toBeNull()
  })

  test('readFile returns the text of a file that exists', async () => {
    const dir = await freshDir()
    await writeFile(join(dir, '.env'), 'DB_PORT=5439\n')

    expect(await createRealIo(join(dir, '.env')).readFile(join(dir, '.env'))).toBe('DB_PORT=5439\n')
  })

  test('readFile rethrows an error that is not "no such file"', async () => {
    const dir = await freshDir()
    // A directory where the file should be: reading it fails with EISDIR, not ENOENT.
    await mkdir(join(dir, '.env'))

    await expect(createRealIo(join(dir, '.env')).readFile(join(dir, '.env'))).rejects.toThrow()
  })

  test('writeFile creates a missing file readable only by its owner', async () => {
    const dir = await freshDir()
    const path = join(dir, '.env')

    await createRealIo(path).writeFile(path, 'API_KEY=x\n')

    expect(await readFile(path, 'utf8')).toBe('API_KEY=x\n')
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(await readdir(dir)).toEqual(['.env'])
  })

  test('writeFile replaces an existing file by rename, keeping its mode and leaving no temp file', async () => {
    const dir = await freshDir()
    const path = join(dir, '.env')
    await writeFile(path, 'DB_PORT=5439\n')
    await chmod(path, 0o640)
    const before = await stat(path)

    await createRealIo(path).writeFile(path, 'DB_PORT=5439\nAPI_KEY=x\n')

    const after = await stat(path)
    expect(await readFile(path, 'utf8')).toBe('DB_PORT=5439\nAPI_KEY=x\n')
    expect(after.mode & 0o777).toBe(0o640)
    // A new inode proves the old file was not truncated and rewritten in place.
    expect(after.ino).not.toBe(before.ino)
    expect(await readdir(dir)).toEqual(['.env'])
  })

  test('writeFile follows a symlinked .env and keeps the link', async () => {
    const dir = await freshDir()
    const target = join(dir, 'real.env')
    const link = join(dir, '.env')
    await writeFile(target, 'DB_PORT=5439\n')
    await symlink(target, link)

    await createRealIo(link).writeFile(link, 'API_KEY=x\n')

    expect((await stat(link)).isFile()).toBe(true)
    expect(await readFile(target, 'utf8')).toBe('API_KEY=x\n')
    expect((await readdir(dir)).sort()).toEqual(['.env', 'real.env'])
  })

  test('a failed writeFile leaves the destination as it was and no temp file behind', async () => {
    const dir = await freshDir()
    // A directory at the destination: the rename cannot succeed.
    await mkdir(join(dir, '.env'))
    await writeFile(join(dir, '.env', 'keep'), 'kept')

    await expect(createRealIo(join(dir, '.env')).writeFile(join(dir, '.env'), 'x')).rejects.toThrow()

    expect(await readdir(dir)).toEqual(['.env'])
    expect(await readdir(join(dir, '.env'))).toEqual(['keep'])
  })
})
