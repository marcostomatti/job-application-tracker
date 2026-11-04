import { chmod, mkdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { backupFileName, partialFileName } from './retention.ts'

/** What to run: a binary, its arguments, and the variables to give it besides `PATH`. */
export type SpawnRequest = {
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
}

/**
 * How a child ended. `exitCode` is `null` when a signal ended it, and `signal` then names it:
 * a killed child is never reported as `128 + signal`, which would read as an ordinary failure
 * code. `stderr` is what the child wrote, cut at a fixed length.
 */
export type SpawnResult = {
  readonly exitCode: number | null
  readonly signal: string | null
  readonly stderr: string
}

/** Runs one child to its end. A test passes a stand-in, so no test runs `pg_dump`. */
export type Spawner = (request: SpawnRequest) => Promise<SpawnResult>

export type RunDumpOptions = {
  /** The connection to dump. It is a credential: it is read here and never written anywhere. */
  readonly databaseUrl: string
  readonly outDir: string
  readonly now: Date
  readonly spawn: Spawner
}

/**
 * A dump that failed. Its message is safe to log and to show: it carries the binary's own
 * stderr with the connection URL, the password and the host name removed, and nothing else
 * from the connection.
 */
export class BackupDumpError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BackupDumpError'
  }
}

const DEFAULT_BINARY = 'pg_dump'

/** Longest wait for a dump of one person's data; a child still running after it is stopped. */
const DEFAULT_TIMEOUT_MS = 10 * 60_000

/** How long to keep reading stderr after the child has gone, in case something else holds the pipe. */
const DEFAULT_DRAIN_MS = 1_000

/**
 * The most of the child's stderr that is kept in memory. This bound does cut before redaction,
 * so a URL straddling it would leave a fragment. That is harmless only because it sits far past
 * `MESSAGE_STDERR_MAX_CHARS`: the credential is removed from the text first and the message is
 * cut afterwards, so none of the characters beyond this bound ever reach a message.
 */
const STDERR_CAPTURE_MAX_CHARS = 64_000

/** The most of the child's stderr, after redaction, that goes into an error message. */
const MESSAGE_STDERR_MAX_CHARS = 4_000

/** How long a child gets, after the SIGTERM at the timeout, before it is sent SIGKILL. */
const DEFAULT_KILL_GRACE_MS = 5_000

const PRIVATE_DIRECTORY_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600
const REDACTED = '[redacted]'
const POSTGRES_PROTOCOLS = new Set(['postgres:', 'postgresql:'])

/**
 * The variables libpq reads, taken from the URL. The binary is given these and not the URL
 * so the credential never appears in its argument list, which any process on the machine can
 * read. Only what libpq needs is kept: host, port, user, password, database and `sslmode`.
 */
function connectionEnv(databaseUrl: string): Record<string, string> {
  const url = new URL(databaseUrl)
  if (!POSTGRES_PROTOCOLS.has(url.protocol)) throw new Error('not a postgres URL')
  const database = decodeURIComponent(url.pathname.slice(1))
  const entries: [string, string | null][] = [
    ['PGHOST', url.hostname.replace(/^\[(.*)\]$/, '$1')],
    ['PGPORT', url.port],
    ['PGUSER', decodeURIComponent(url.username)],
    ['PGPASSWORD', decodeURIComponent(url.password)],
    ['PGDATABASE', database],
    ['PGSSLMODE', url.searchParams.get('sslmode')],
  ]
  return Object.fromEntries(entries.filter((entry): entry is [string, string] => entry[1] !== null && entry[1] !== ''))
}

/** Every spelling of the credential that stderr or an error message could repeat. */
function secretsIn(databaseUrl: string, env: Readonly<Record<string, string>>): string[] {
  const candidates = [databaseUrl, env.PGPASSWORD, safePassword(databaseUrl)]
  return [...new Set(candidates.filter((value): value is string => value !== undefined && value !== ''))].sort(
    (a, b) => b.length - a.length,
  )
}

/** The password as the URL spells it (percent-encoded), or nothing when the URL cannot be read. */
function safePassword(databaseUrl: string): string | undefined {
  try {
    return new URL(databaseUrl).password
  } catch {
    return undefined
  }
}

/** Removes the credential and the machine's name from text; built once per dump by `redactorFor`. */
type Redactor = (text: string) => string

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g

/**
 * A pattern for the host as a whole name. A host such as `db` is also a stretch of "database", so
 * a plain substring replace would mangle the message around it; the name has to stand alone, which
 * means not touching another name character on either side. A dot on the right ends the name
 * unless a name character follows it, so a sentence's full stop counts and `db.other` does not.
 */
function hostPattern(host: string): RegExp {
  const escaped = host.replace(REGEX_SPECIAL, String.raw`\$&`)
  return new RegExp(String.raw`(?<![A-Za-z0-9_.-])${escaped}(?![A-Za-z0-9_-]|\.[A-Za-z0-9])`, 'gi')
}

/**
 * What stderr or an error message is cleaned with: every spelling of the credential, then the
 * host. `pg_dump` prints the host when a connection fails, and the machine's name in a local log
 * is something a person pastes into a bug report without reading it. The URL is removed first,
 * since it contains the host.
 */
function redactorFor(databaseUrl: string, env: Readonly<Record<string, string>>): Redactor {
  const secrets = secretsIn(databaseUrl, env)
  const host = env.PGHOST === undefined || env.PGHOST === '' ? undefined : hostPattern(env.PGHOST)
  return (text) => {
    const withoutSecrets = secrets.reduce((clean, secret) => clean.split(secret).join(REDACTED), text)
    return host === undefined ? withoutSecrets : withoutSecrets.replace(host, REDACTED)
  }
}

/** The part of a spawner's failure that is safe to repeat: its error code, never its message. */
function codeOf(error: unknown): string {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
  return typeof code === 'string' ? code : 'unknown'
}

function describeFailure(result: SpawnResult, redact: Redactor): string {
  const how = result.signal === null ? `exited with code ${result.exitCode ?? 'unknown'}` : `was stopped by ${result.signal}`
  // Redact first, cut second: see STDERR_CAPTURE_MAX_CHARS.
  const stderr = redact(result.stderr).trim().slice(0, MESSAGE_STDERR_MAX_CHARS)
  return stderr === '' ? `pg_dump ${how}` : `pg_dump ${how}: ${stderr}`
}

async function removeQuietly(path: string): Promise<void> {
  await rm(path, { force: true })
}

/**
 * Writes one custom-format dump into `outDir` and returns its path.
 *
 * The connection URL is the credential this function exists to protect. It is split into the
 * `PG*` variables the binary reads, so it is in no argument, no file name and no log (this
 * function logs nothing), and every message it raises has the URL, the password and the host removed.
 * A failing `pg_dump` still reports its own stderr, which is where the reason is.
 *
 * The dump is written beside its final name and moved into place only once the child has
 * ended cleanly, so a failed or killed dump never leaves a file that retention would count as
 * the newest backup. The directory and the file are private to their owner, because a dump is
 * the personal data the rest of the project keeps out of the repository.
 */
export async function runDump(opts: RunDumpOptions): Promise<string> {
  let env: Record<string, string>
  try {
    env = connectionEnv(opts.databaseUrl)
  } catch {
    // The reason is dropped on purpose: a URL parse error can quote the URL.
    throw new BackupDumpError('DATABASE_URL is not a usable postgres connection URL')
  }
  const redact = redactorFor(opts.databaseUrl, env)
  const finalPath = join(opts.outDir, backupFileName(opts.now))
  const partialPath = partialFileName(finalPath)

  await mkdir(opts.outDir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
  const result = await runBinary(opts, env, partialPath, redact)
  if (result.exitCode !== 0) {
    await removeQuietly(partialPath)
    throw new BackupDumpError(describeFailure(result, redact))
  }
  const written = await stat(partialPath).catch(() => null)
  if (!written || written.size === 0) {
    await removeQuietly(partialPath)
    throw new BackupDumpError('pg_dump exited cleanly but wrote no file')
  }
  await chmod(partialPath, PRIVATE_FILE_MODE)
  await rename(partialPath, finalPath)
  return finalPath
}

async function runBinary(
  opts: RunDumpOptions,
  env: Readonly<Record<string, string>>,
  partialPath: string,
  redact: Redactor,
): Promise<SpawnResult> {
  const command = process.env.PG_DUMP_BIN || DEFAULT_BINARY
  const args = ['--format=custom', '--no-password', `--file=${partialPath}`]
  try {
    return await opts.spawn({ command, args, env })
  } catch (error: unknown) {
    await removeQuietly(partialPath)
    const reason = error instanceof BackupDumpError ? error.message : `${error instanceof Error ? error.message : ''}`
    throw new BackupDumpError(redact(`pg_dump could not be run (${codeOf(error)}): ${reason}`).trim())
  }
}

export type BunSpawnerOptions = {
  readonly timeoutMs?: number
  /** How long after the SIGTERM at the timeout the child may keep running before SIGKILL. */
  readonly killGraceMs?: number
  readonly drainMs?: number
}

type StderrCapture = { readonly finished: Promise<void>; text(): string; cancel(): Promise<void> }

/** Collects a child's stderr as it arrives, so what was written is there even if the pipe never closes. */
function captureStderr(stream: ReadableStream<Uint8Array>): StderrCapture {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let text = ''
  const finished = (async () => {
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) return
        if (text.length < STDERR_CAPTURE_MAX_CHARS) text += decoder.decode(chunk.value, { stream: true })
      }
    } catch {
      // A read that fails after cancel() is the expected end of an abandoned pipe; what arrived is kept.
    }
  })()
  return { finished, text: () => text.slice(0, STDERR_CAPTURE_MAX_CHARS), cancel: () => reader.cancel().catch(() => undefined) }
}

/**
 * The production `Spawner`: runs the binary with `Bun.spawn`, with the given variables and
 * `PATH` and nothing else from this process's environment.
 *
 * A child's ending is read from the child, not from the exit code alone: after `exited`,
 * `signalCode` names a signal and `exitCode` is `null`, whereas `exited` itself reads 137 for
 * a SIGKILL and 143 for a SIGTERM. A child still running at the timeout is sent SIGTERM, and
 * SIGKILL after a grace period if it ignores that, and is then awaited, so none outlives the call
 * and none can hold the schedule, or its shutdown, for ever. Stderr is read as it arrives and abandoned shortly after
 * the child ends, because quitting a pipe read does not stop the child, and a read to the end
 * of the pipe also waits on any other process that inherited it.
 */
export function createBunSpawner(options: BunSpawnerOptions = {}): Spawner {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const drainMs = options.drainMs ?? DEFAULT_DRAIN_MS
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS
  return async ({ command, args, env }) => {
    const child = startChild(command, args, env)
    const stderr = captureStderr(child.stderr)
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const timer = setTimeout(() => {
      child.kill()
      killTimer = setTimeout(() => child.kill('SIGKILL'), killGraceMs)
    }, timeoutMs)
    try {
      await child.exited
    } finally {
      clearTimeout(timer)
      clearTimeout(killTimer)
    }
    await drainOrAbandon(stderr, drainMs)
    return { exitCode: child.exitCode, signal: child.signalCode === null ? null : String(child.signalCode), stderr: stderr.text() }
  }
}

/** Starts the child, with `PATH` and the given variables only. Its start-up error is reduced to a code. */
function startChild(command: string, args: readonly string[], env: Readonly<Record<string, string>>) {
  const path = process.env.PATH
  try {
    return Bun.spawn([command, ...args], {
      env: path === undefined ? { ...env } : { PATH: path, ...env },
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'pipe',
    })
  } catch (error: unknown) {
    // The error's own message can name the arguments, so only its code is kept.
    throw new BackupDumpError(`${command} could not be started (${codeOf(error)})`)
  }
}

async function drainOrAbandon(stderr: StderrCapture, drainMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const gaveUp = new Promise<'abandoned'>((resolve) => {
    timer = setTimeout(() => resolve('abandoned'), drainMs)
  })
  const outcome = await Promise.race([stderr.finished.then(() => 'drained' as const), gaveUp])
  clearTimeout(timer)
  if (outcome === 'abandoned') await stderr.cancel()
}
