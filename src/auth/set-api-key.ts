import { randomUUID } from 'node:crypto'
import { chmod, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { generateApiKey } from './api-key.ts'

/** Erase the screen (2J), the scrollback (3J), then send the cursor home (H). */
export const CLEAR_SCREEN_AND_SCROLLBACK = '\x1b[2J\x1b[3J\x1b[H'

/** How long the key stays on screen before it is cleared. */
const BURN_SECONDS = 30

const BURN_FLAG = '--burn-after-reading'

/** An active `API_KEY=` line: the name may be indented or follow `export`, as a shell or dotenv parser allows. */
const ENV_KEY_LINE = /^\s*(?:export\s+)?API_KEY=/

/**
 * An active `API_KEY=` line split into its prefix (indent and `export`, kept as written) and
 * its trailing comment (whitespace, then `#`, to the end).
 *
 * A value that opens with a quote is read to its closing quote, so a `#` inside the quotes is
 * part of the value and a comment is only recognised after the closing quote. A quote that is
 * never closed matches nothing, so the whole value is replaced and no fragment is left. An
 * unquoted value is matched lazily, so the first whitespace-then-`#` starts the comment; a
 * generated key is base64url behind `jat_` and holds no `#` or whitespace, so that split
 * cannot cut one in two.
 */
const ENV_KEY_LINE_PARTS = /^(\s*(?:export\s+)?)API_KEY=(?:(["']).*?\2|(?!["']).*?)(\s+#.*)?$/

/** A newly created `.env` holds a secret, so only its owner may read it (an existing file keeps its mode). */
const NEW_ENV_FILE_MODE = 0o600

/** The project's `.env`, found from this file and not from wherever the script was started. */
const DEFAULT_ENV_PATH = resolve(import.meta.dir, '../../.env')

/** Whether the env file text already has an active (uncommented) `API_KEY=` line, indented or `export`ed or not. */
export function hasApiKeyLine(current: string): boolean {
  return current.split('\n').some((line) => ENV_KEY_LINE.test(line))
}

/** One `API_KEY=` line with its value replaced; its prefix, trailing comment and line ending are kept. */
function replaceValueOnLine(line: string, key: string): string {
  const lineEnding = line.endsWith('\r') ? '\r' : ''
  const text = lineEnding ? line.slice(0, -1) : line
  const parts = ENV_KEY_LINE_PARTS.exec(text)
  const prefix = parts?.[1] ?? text.slice(0, text.indexOf('API_KEY='))
  const trailingComment = parts?.[3] ?? ''
  return `${prefix}API_KEY=${key}${trailingComment}${lineEnding}`
}

/**
 * The text of an env file with `API_KEY` set to `key`: every `API_KEY=` line (indented or
 * `export`ed too) has its value replaced in place (a trailing `# comment` on it stays), and
 * one line is appended when there is none. Other lines, commented ones included, are returned
 * untouched. The line ending the file already uses (LF or CRLF) is kept.
 *
 * `current` is the file's existing text (empty for a file that does not exist yet). This
 * function reads and writes nothing, so a caller decides when and where the result is saved.
 */
export function replaceApiKeyLine(current: string, key: string): string {
  if (key.length === 0 || /\s/.test(key)) {
    throw new Error('The API key must be non-empty and contain no whitespace.')
  }

  if (hasApiKeyLine(current)) {
    return current
      .split('\n')
      .map((line) => (ENV_KEY_LINE.test(line) ? replaceValueOnLine(line, key) : line))
      .join('\n')
  }

  const newline = current.includes('\r\n') ? '\r\n' : '\n'
  const keyLine = `API_KEY=${key}`
  if (current.length === 0) return `${keyLine}${newline}`
  const separator = current.endsWith('\n') ? '' : newline
  return `${current}${separator}${keyLine}${newline}`
}

/** Shown only when a key was replaced: clients on the old key get 401s until they are updated. */
const REPLACED_NOTICE =
  'This replaced the API_KEY that was already in .env: any client using the old key must be updated, or its requests will be refused.'

/** Written after the clear, so it stays on screen once the key is gone. Holds no key. */
const REPLACED_REMINDER =
  'Cleared. The API_KEY in .env was replaced: update any client that still uses the old key.\n'

type BurnAfterReadingOptions = {
  key: string
  seconds: number
  /** True when `.env` already held a key, which this one replaces. */
  replacedExisting?: boolean
  write: (text: string) => void
  clear: () => void
  wait: (ms: number) => Promise<void>
  /** Run `handler` if the process is interrupted; the returned function stops listening. */
  onInterrupt: (handler: () => void) => () => void
}

/**
 * Show the key, wait, then clear the screen. The text speaks to an agent as well as a
 * person, because an agent running this script reads the terminal and has to take the value
 * before the clear.
 *
 * The screen is cleared on every way out that code can handle: the wait ending, the wait or
 * the write failing, and an interrupt (SIGINT, SIGTERM) during the window, which clears at
 * once and does not wait the timer out. The listener is registered before the key is printed,
 * so no signal can land in a gap, and it is removed when the window closes. A signal that
 * cannot be handled (SIGKILL) or a terminal that is closed (SIGHUP) is not covered. The
 * clear runs once however many of these happen, and when a key was replaced the warning is
 * written after it, so it outlasts the key.
 */
export async function burnAfterReading(options: BurnAfterReadingOptions): Promise<void> {
  const { key, seconds, replacedExisting = false, write, clear, wait, onInterrupt } = options

  let cleared = false
  const clearOnce = (): void => {
    if (cleared) return
    cleared = true
    clear()
    // The key is gone from the screen now; the warning is the part that must outlast the clear.
    if (replacedExisting) write(REPLACED_REMINDER)
  }

  const stopListening = onInterrupt(clearOnce)
  try {
    write(
      [
        `Your new API key: ${key}`,
        '',
        `Agent or person reading this: read the key now, immediately. This screen is cleared in ${seconds} seconds.`,
        'The key is already saved in .env as API_KEY. If you missed it, run: cat .env',
        ...(replacedExisting ? [REPLACED_NOTICE] : []),
        '',
      ].join('\n'),
    )
    await wait(seconds * 1000)
  } finally {
    clearOnce()
    stopListening()
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
  onInterrupt: (handler: () => void) => () => void
}

/** What `registerInterrupt` needs from `process`, so a test can stand in for it without real signals. */
type InterruptTarget = {
  once: (signal: 'SIGINT' | 'SIGTERM', listener: () => void) => unknown
  off: (signal: 'SIGINT' | 'SIGTERM', listener: () => void) => unknown
  exit: (code: number) => unknown
}

/** The conventional exit code for death by a signal: 128 plus its number. */
const INTERRUPT_SIGNALS = [
  ['SIGINT', 130],
  ['SIGTERM', 143],
] as const

/**
 * On SIGINT or SIGTERM, run `handler` and then exit with that signal's code. Node and Bun
 * stop their default termination once a listener exists, so the exit has to be explicit, and
 * it runs even when the handler throws. The returned function removes both listeners.
 */
export function registerInterrupt(
  handler: () => void,
  target: InterruptTarget = process,
): () => void {
  const registered = INTERRUPT_SIGNALS.map(([signal, exitCode]) => {
    const listener = (): void => {
      try {
        handler()
      } finally {
        target.exit(exitCode)
      }
    }
    target.once(signal, listener)
    return { signal, listener }
  })

  return () => {
    for (const { signal, listener } of registered) target.off(signal, listener)
  }
}

/** The file's mode if it exists, so a replacement keeps it; `undefined` for a file not yet created. */
async function existingMode(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mode & 0o777
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * Replace a file's contents without a moment when it is empty: the text goes to a temporary
 * file in the same directory (the same filesystem, so the rename is atomic), which is then
 * renamed over the original. A failure before the rename leaves the original as it was, and
 * the temporary file is removed. A symlink is followed, so the link is kept and its target is
 * replaced. The original's mode is kept, and a new file is created owner-only.
 */
async function replaceFileAtomically(path: string, text: string): Promise<void> {
  const target = await realpath(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return path
    throw error
  })
  const mode = (await existingMode(target)) ?? NEW_ENV_FILE_MODE
  const temporary = `${target}.${randomUUID()}.tmp`

  try {
    await writeFile(temporary, text, { mode, flag: 'wx' })
    // `mode` above is trimmed by the umask, so set it again to keep the original exactly.
    await chmod(temporary, mode)
    await rename(temporary, target)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

/** The real terminal and file system, with `envPath` as the file to update. */
export function createRealIo(envPath: string): MainIo {
  return {
    envPath,
    readFile: async (path) => {
      try {
        return await readFile(path, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      }
    },
    writeFile: replaceFileAtomically,
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
    onInterrupt: (handler) => registerInterrupt(handler),
  }
}

const USAGE = [
  'Usage: bun run setApiKey --burn-after-reading',
  '',
  'Generates an API key, saves it as API_KEY in .env, shows it once, then clears the screen.',
  `The ${BURN_FLAG} flag is required: without it the key would stay in the scrollback.`,
  '',
].join('\n')

/** Run the script and return its exit code: 0 on success, 1 when nothing was saved or shown. */
export async function main(argv: readonly string[], io: MainIo): Promise<number> {
  if (!argv.includes(BURN_FLAG)) {
    io.writeError(USAGE)
    return 1
  }

  const key = generateApiKey()
  let replacedExisting = false

  // The file is saved before the key is shown, so a key on screen is always one that `.env` holds.
  try {
    const current = (await io.readFile(io.envPath)) ?? ''
    replacedExisting = hasApiKeyLine(current)
    await io.writeFile(io.envPath, replaceApiKeyLine(current, key))
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    io.writeError(`Could not save the API key to ${io.envPath}: ${reason}\n`)
    return 1
  }

  await burnAfterReading({
    key,
    seconds: BURN_SECONDS,
    replacedExisting,
    write: io.write,
    clear: io.clear,
    wait: io.wait,
    onInterrupt: io.onInterrupt,
  })
  return 0
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2), createRealIo(DEFAULT_ENV_PATH))
}
