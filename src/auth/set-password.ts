import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { readEnvValue, setEnvValue } from './env-file.ts'
import { hashPassword } from './password-hash.ts'
import { replaceFileAtomically } from './set-api-key.ts'

const DEFAULT_ENV_PATH = resolve(import.meta.dir, '../../.env')

/** Below this, the script warns but still saves: the password guards a drawer, and its length is the user's call. */
const SHORT_PASSWORD = 8

/** The side effects `main` needs, so a test runs it with none of them real. */
export interface SetPasswordIo {
  readonly envPath: string
  readFile(path: string): Promise<string | null>
  writeFile(path: string, text: string): Promise<void>
  /** Asks for a secret; the answer is not echoed. */
  askSecret(prompt: string): Promise<string>
  write(text: string): void
  writeError(text: string): void
}

/**
 * Asks for a password twice, then writes its scrypt hash into `.env` as `AUTH_PASSWORD_HASH`
 * and sets `AUTH_MODE=password` when no mode is set. The password itself is never written or
 * printed. Returns the exit code.
 */
export async function main(io: SetPasswordIo): Promise<number> {
  const password = await io.askSecret('New password: ')
  if (password.length === 0) {
    io.writeError('No password given; nothing was changed.\n')
    return 1
  }
  if ((await io.askSecret('Again, to confirm: ')) !== password) {
    io.writeError('The two passwords differ; nothing was changed.\n')
    return 1
  }
  if (password.length < SHORT_PASSWORD) io.write(`Note: that password is shorter than ${SHORT_PASSWORD} characters.\n`)

  try {
    const current = (await io.readFile(io.envPath)) ?? ''
    let next = setEnvValue(current, 'AUTH_PASSWORD_HASH', await hashPassword(password))
    const mode = readEnvValue(current, 'AUTH_MODE')
    if (mode === undefined || mode === '') next = setEnvValue(next, 'AUTH_MODE', 'password')
    await io.writeFile(io.envPath, next)
    io.write(
      mode === 'oidc'
        ? 'Saved AUTH_PASSWORD_HASH, but AUTH_MODE is oidc; set AUTH_MODE=password in .env to sign in with it.\n'
        : 'Saved. Restart `bun run serve` and sign in at /login.\n',
    )
    return 0
  } catch (error: unknown) {
    io.writeError(`Could not save the password hash to ${io.envPath}: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

/** Reads one line from a terminal with echo off; a pipe is read as its first line. */
function askSecretFromTerminal(prompt: string): Promise<string> {
  const stdin = process.stdin
  process.stdout.write(prompt)
  if (!stdin.isTTY) {
    return new Response(Bun.stdin.stream()).text().then((text) => text.split(/\r?\n/)[0] ?? '')
  }
  return new Promise((done) => {
    let answer = ''
    stdin.setRawMode(true)
    stdin.resume()
    const onData = (chunk: Buffer): void => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\r' || char === '\n') {
          stdin.off('data', onData)
          stdin.setRawMode(false)
          stdin.pause()
          process.stdout.write('\n')
          done(answer)
          return
        }
        if (char === '\u0003') {
          stdin.setRawMode(false)
          process.stdout.write('\n')
          process.exit(130)
        }
        answer = char === '\u007f' || char === '\b' ? answer.slice(0, -1) : answer + char
      }
    }
    stdin.on('data', onData)
  })
}

if (import.meta.main) {
  process.exitCode = await main({
    envPath: DEFAULT_ENV_PATH,
    readFile: async (path) => readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => (error.code === 'ENOENT' ? null : Promise.reject(error))),
    writeFile: (path, text) => replaceFileAtomically(path, text),
    askSecret: askSecretFromTerminal,
    write: (text) => void process.stdout.write(text),
    writeError: (text) => void process.stderr.write(text),
  })
}
