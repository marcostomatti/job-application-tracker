import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { closeDb, getDb } from '../data/client.ts'
import type { Db } from '../data/repositories/db.ts'
import { readEnvValue, removeEnvValue } from './env-file.ts'
import { replaceFileAtomically } from './set-api-key.ts'
import { clearCredentials } from './store.ts'

const DEFAULT_ENV_PATH = resolve(import.meta.dir, '../../.env')

/** The side effects `main` needs, so a test runs it against a scratch database and an in-memory file. */
export interface ResetIo {
  readonly envPath: string
  readonly db: Db
  readFile(path: string): Promise<string | null>
  writeFile(path: string, text: string): Promise<void>
  write(text: string): void
  writeError(text: string): void
}

function nextSteps(mode: string | undefined): string[] {
  if (mode === 'oidc') {
    return [
      'AUTH_MODE is oidc: sign in again at /login with the account OIDC_ALLOWED_SUBJECT or OIDC_ALLOWED_EMAIL names.',
      'To switch to a password instead, run `bun run set-password` and set AUTH_MODE=password in .env.',
    ]
  }
  return ['Run `bun run set-password` to choose a new password, then restart `bun run serve` and sign in at /login.']
}

/**
 * The one recovery path, for someone who has the code and lost the password: every session and
 * every API token is deleted, the cookie secret is dropped (so any cookie still in a browser is
 * worthless), and `AUTH_PASSWORD_HASH` is removed from `.env`. `API_KEY` and the OIDC settings
 * are left alone. Then it says what to do next. Returns the exit code.
 */
export async function main(io: ResetIo): Promise<number> {
  let cleared: Awaited<ReturnType<typeof clearCredentials>>
  try {
    cleared = await clearCredentials(io.db)
  } catch (error: unknown) {
    const code = (error as { code?: unknown }).code
    io.writeError(`Could not clear sessions and tokens (${typeof code === 'string' ? code : 'unknown error'}). Is the database running? Try \`bun run db:up\`.\n`)
    return 1
  }

  let mode: string | undefined
  let removedHash = false
  try {
    const current = await io.readFile(io.envPath)
    if (current !== null) {
      mode = readEnvValue(current, 'AUTH_MODE')
      const { text, removed } = removeEnvValue(current, 'AUTH_PASSWORD_HASH')
      removedHash = removed
      if (removed) await io.writeFile(io.envPath, text)
    }
  } catch (error: unknown) {
    io.writeError(`Sessions and tokens are cleared, but ${io.envPath} could not be updated: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }

  io.write(
    [
      `Cleared ${cleared.sessions} session(s) and ${cleared.tokens} API token(s); every browser is signed out.`,
      removedHash ? 'Removed AUTH_PASSWORD_HASH from .env.' : 'No AUTH_PASSWORD_HASH was set in .env.',
      'API_KEY is unchanged; to replace it, run `bun run setApiKey --burn-after-reading`.',
      'Agents and clients that used a minted token need a new one from the Tokens page.',
      ...nextSteps(mode),
      '',
    ].join('\n'),
  )
  return 0
}

if (import.meta.main) {
  try {
    process.exitCode = await main({
      envPath: DEFAULT_ENV_PATH,
      db: getDb(),
      readFile: async (path) => readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => (error.code === 'ENOENT' ? null : Promise.reject(error))),
      writeFile: (path, text) => replaceFileAtomically(path, text),
      write: (text) => void process.stdout.write(text),
      writeError: (text) => void process.stderr.write(text),
    })
  } finally {
    await closeDb()
  }
}
