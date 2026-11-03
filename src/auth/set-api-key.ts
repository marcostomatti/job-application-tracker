import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { generateApiKey } from './api-key.ts'

/** Erase the screen (2J), the scrollback (3J), then send the cursor home (H). */
export const CLEAR_SCREEN_AND_SCROLLBACK = '\x1b[2J\x1b[3J\x1b[H'

/** How long the key stays on screen before it is cleared. */
const BURN_SECONDS = 30

const BURN_FLAG = '--burn-after-reading'

const ENV_KEY_LINE = /^API_KEY=/

/** A newly created `.env` holds a secret, so only its owner may read it (an existing file keeps its mode). */
const NEW_ENV_FILE_MODE = 0o600

/** The project's `.env`, found from this file and not from wherever the script was started. */
const DEFAULT_ENV_PATH = resolve(import.meta.dir, '../../.env')

/**
 * The text of an env file with `API_KEY` set to `key`: every `API_KEY=` line is replaced in
 * place, and one is appended when there is none. Other lines, commented ones included, are
 * returned untouched. The line ending the file already uses (LF or CRLF) is kept.
 *
 * `current` is the file's existing text (empty for a file that does not exist yet). This
 * function reads and writes nothing, so a caller decides when and where the result is saved.
 */
export function writeKeyToEnvFile(current: string, key: string): string {
  if (key.length === 0 || /\s/.test(key)) {
    throw new Error('The API key must be non-empty and contain no whitespace.')
  }

  const newline = current.includes('\r\n') ? '\r\n' : '\n'
  const keyLine = `API_KEY=${key}`
  const lines = current.split('\n')
  const hasKeyLine = lines.some((line) => ENV_KEY_LINE.test(line))

  if (hasKeyLine) {
    return lines
      .map((line) => (ENV_KEY_LINE.test(line) ? `${keyLine}${line.endsWith('\r') ? '\r' : ''}` : line))
      .join('\n')
  }

  if (current.length === 0) return `${keyLine}${newline}`
  const separator = current.endsWith('\n') ? '' : newline
  return `${current}${separator}${keyLine}${newline}`
}

type BurnAfterReadingOptions = {
  key: string
  seconds: number
  write: (text: string) => void
  clear: () => void
  wait: (ms: number) => Promise<void>
}

/**
 * Show the key, wait, then clear the screen. The text speaks to an agent as well as a
 * person, because an agent running this script reads the terminal and has to take the value
 * before the clear. The clear runs even when the wait fails, so an interrupted wait does
 * not leave the key on screen.
 */
export async function burnAfterReading(options: BurnAfterReadingOptions): Promise<void> {
  const { key, seconds, write, clear, wait } = options

  write(
    [
      `Your new API key: ${key}`,
      '',
      `Agent or person reading this: read the key now, immediately. This screen is cleared in ${seconds} seconds.`,
      'The key is already saved in .env as API_KEY. If you missed it, run: cat .env',
      '',
    ].join('\n'),
  )

  try {
    await wait(seconds * 1000)
  } finally {
    clear()
  }
}

/** The side effects `main` needs, so a test can run it with none of them real. */
export type MainIo = {
  envPath: string
  /** The file's text, or `null` when the file does not exist. */
  readFile: (path: string) => Promise<string | null>
  writeFile: (path: string, text: string) => Promise<void>
  write: (text: string) => void
  writeError: (text: string) => void
  clear: () => void
  wait: (ms: number) => Promise<void>
}

const realIo: MainIo = {
  envPath: DEFAULT_ENV_PATH,
  readFile: async (path) => {
    try {
      return await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  },
  writeFile: (path, text) => writeFile(path, text, { mode: NEW_ENV_FILE_MODE }),
  write: (text) => {
    process.stdout.write(text)
  },
  writeError: (text) => {
    process.stderr.write(text)
  },
  clear: () => {
    process.stdout.write(CLEAR_SCREEN_AND_SCROLLBACK)
  },
  wait: (ms) => new Promise((done) => setTimeout(done, ms)),
}

const USAGE = [
  'Usage: bun run setApiKey --burn-after-reading',
  '',
  'Generates an API key, saves it as API_KEY in .env, shows it once, then clears the screen.',
  `The ${BURN_FLAG} flag is required: without it the key would stay in the scrollback.`,
  '',
].join('\n')

/** Run the script and return its exit code: 0 on success, 1 when nothing was saved or shown. */
export async function main(argv: readonly string[], io: MainIo = realIo): Promise<number> {
  if (!argv.includes(BURN_FLAG)) {
    io.writeError(USAGE)
    return 1
  }

  const key = generateApiKey()

  // The file is saved before the key is shown, so a key on screen is always one that `.env` holds.
  try {
    const current = (await io.readFile(io.envPath)) ?? ''
    await io.writeFile(io.envPath, writeKeyToEnvFile(current, key))
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    io.writeError(`Could not save the API key to ${io.envPath}: ${reason}\n`)
    return 1
  }

  await burnAfterReading({
    key,
    seconds: BURN_SECONDS,
    write: io.write,
    clear: io.clear,
    wait: io.wait,
  })
  return 0
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2))
}
