import { readdir, rm, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

import { createDependency } from '@open-tomato/service-express'
import { createLogger } from '@open-tomato/service-logger'

import { closeDb, getDb, MissingDatabaseUrlError } from '../data/client.ts'
import { readBackupSettings } from '../data/repositories/config.ts'
import type { Db } from '../data/repositories/db.ts'
import type { BackupSettings } from '../schemas/config.ts'
import { BackupDumpError, createBunSpawner, runDump, type Spawner } from './dump.ts'
import { isBackupFileName, isPartialFileName, parseBackupTime, planRetention, type BackupFile } from './retention.ts'

/** Where dumps go: `backups/` at the repository root, which `.gitignore` excludes. */
export const DEFAULT_BACKUP_DIR = resolve(import.meta.dir, '../../backups')

const DAY_MS = 86_400_000

/**
 * How long a partial dump must have gone unwritten before it is swept. A dump in flight is
 * stopped after ten minutes, so a partial untouched for an hour belongs to a process that died.
 * The wait is what keeps a sweep from removing the file another process is writing right now.
 */
const STALE_PARTIAL_MS = 3_600_000

/**
 * How often the schedule asks whether a backup is due: hourly. The interval itself is in days
 * and is checked against the newest backup on disk, not counted down in a timer, for two
 * reasons. A timer longer than 2^31 - 1 ms (about 24.8 days) fires at once, and a stored
 * interval may be up to 1,000 days. And a countdown restarts with the process, so a service
 * restarted every week would never reach a fortnight; the age of the newest file survives a restart.
 */
const CHECK_EVERY_MS = 3_600_000

/** What the schedule logs with. The `service-logger` `Logger` satisfies this. */
export type BackupLog = {
  info(context: object, message: string): void
  warn(context: object, message: string): void
  error(context: object, message: string): void
}

/** The timer calls the schedule makes, so a test can see them and run a tick by hand. */
export type BackupTimers = {
  setInterval(run: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
}

export type BackupOptions = {
  readonly db: Db
  readonly outDir: string
  /** Runs `pg_dump`. Defaults to the real one; a test passes a stand-in. */
  readonly spawn?: Spawner
  /** The connection to dump. Defaults to `DATABASE_URL`. It is a credential and is never logged. */
  readonly databaseUrl?: string
  readonly now?: () => Date
  readonly logger?: BackupLog
}

export type BackupScheduleOptions = BackupOptions & { readonly timers?: BackupTimers }

/** What a service passes to run the schedule beside it: the options but for the database, and the directory is optional. */
export type BackupWiring = Omit<BackupScheduleOptions, 'db' | 'outDir'> & {
  readonly outDir?: string
  /** Where the settings are read from. Defaults to the service's own database; a test passes a scratch one. */
  readonly db?: Db
}

export type BackupResult = { readonly path: string; readonly dropped: number }

let cachedLogger: BackupLog | undefined

function defaultLogger(): BackupLog {
  cachedLogger ??= createLogger('backup')
  return cachedLogger
}

const realTimers: BackupTimers = {
  setInterval: (run, ms) => {
    const handle = setInterval(run, ms)
    handle.unref()
    return handle
  },
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
}

/**
 * What a log line says about a failure. A dump failure's message is already free of the URL.
 * Any other error is reduced to its class name, because a driver or file-system message can
 * carry an address, a path or a SQL fragment.
 */
function describeError(error: unknown): string {
  if (error instanceof BackupDumpError) return error.message
  return error instanceof Error ? `unexpected ${error.name}` : 'unexpected failure'
}

/** The directory's entries, or none when it does not exist yet. */
async function entriesOf(outDir: string): Promise<string[]> {
  return readdir(outDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
}

async function listBackups(outDir: string): Promise<BackupFile[]> {
  return (await entriesOf(outDir)).filter(isBackupFileName).map((name) => ({ name }))
}

/** Whether the newest backup is at least `intervalDays` old, or there is none. */
function isDue(files: readonly BackupFile[], intervalDays: number, now: Date): boolean {
  const [newest] = planRetention(files, 1).keep
  const taken = newest ? parseBackupTime(newest.name) : null
  return taken === null || now.getTime() - taken.getTime() >= intervalDays * DAY_MS
}

/** Removes the backups a plan drops. One that cannot be removed is logged and skipped, so the rest still go. */
async function removeDropped(outDir: string, drop: readonly BackupFile[], log: BackupLog): Promise<number> {
  const removals = await Promise.all(
    drop.map(async ({ name }) => {
      try {
        await rm(join(outDir, name))
        return 1
      } catch (error: unknown) {
        log.warn({ file: name, reason: describeError(error) }, 'an old backup could not be removed')
        return 0
      }
    }),
  )
  return removals.reduce<number>((total, removed) => total + removed, 0)
}

/**
 * Removes partial dumps left by a process that died mid-dump. They are personal data in the
 * directory this feature manages, and nothing else would ever remove them. Only a stale one
 * goes (see `STALE_PARTIAL_MS`); one that cannot be removed is logged and skipped.
 */
async function sweepStalePartials(outDir: string, now: Date, log: BackupLog): Promise<void> {
  let names: string[]
  try {
    names = (await entriesOf(outDir)).filter(isPartialFileName)
  } catch (error: unknown) {
    log.warn({ reason: describeError(error) }, 'the backup directory could not be read for stale partials')
    return
  }
  const swept = await Promise.all(
    names.map(async (name) => {
      try {
        const { mtimeMs } = await stat(join(outDir, name))
        if (now.getTime() - mtimeMs < STALE_PARTIAL_MS) return 0
        await rm(join(outDir, name), { force: true })
        return 1
      } catch (error: unknown) {
        log.warn({ file: name, reason: describeError(error) }, 'a stale partial backup could not be removed')
        return 0
      }
    }),
  )
  const count = swept.reduce<number>((total, removed) => total + removed, 0)
  if (count > 0) log.info({ count }, 'removed stale partial backups')
}

/** Dumps now, then keeps the `keep` newest backups. A failed dump removes nothing, so the last good one stays. */
async function dumpAndPrune(opts: BackupOptions, settings: BackupSettings): Promise<BackupResult> {
  const databaseUrl = opts.databaseUrl ?? process.env.DATABASE_URL
  if (!databaseUrl) throw new MissingDatabaseUrlError()
  const log = opts.logger ?? defaultLogger()
  const path = await runDump({
    databaseUrl,
    outDir: opts.outDir,
    now: (opts.now ?? (() => new Date()))(),
    spawn: opts.spawn ?? createBunSpawner(),
  })
  const plan = planRetention(await listBackups(opts.outDir), settings.keep)
  const dropped = await removeDropped(opts.outDir, plan.drop, log)
  return { path, dropped }
}

/**
 * One backup now, whatever the interval says and whether or not the schedule is on: a person
 * who runs this has asked for it. `keep` is still read from `app_config`, so the directory
 * does not grow.
 */
export async function runBackupOnce(opts: BackupOptions): Promise<BackupResult> {
  const log = opts.logger ?? defaultLogger()
  await sweepStalePartials(opts.outDir, (opts.now ?? (() => new Date()))(), log)
  return dumpAndPrune(opts, await readBackupSettings(opts.db, log))
}

/**
 * Starts the backup schedule. With `enabled: false` stored it returns at once with no timer.
 * If the settings cannot be read at start, the schedule starts anyway and tries again at each check.
 *
 * Otherwise it first sweeps stale partial dumps, then checks whether a backup is due before it returns, and then hourly: a backup
 * is due when none exists or the newest is at least `intervalDays` old. Every check reads
 * the settings again, so turning backups off, or changing `keep` or the interval, applies at
 * the next check without a restart. Checks run one after another, never overlapping.
 *
 * A failed backup is logged (with the dump's own error text and no connection URL) and the
 * schedule goes on; it never throws into the caller's timer. `stop()` clears the timer and
 * waits for a check already running.
 */
export async function startBackupSchedule(opts: BackupScheduleOptions): Promise<{ stop(): Promise<void> }> {
  const log = opts.logger ?? defaultLogger()
  const timers = opts.timers ?? realTimers
  const now = opts.now ?? (() => new Date())
  // A read that fails here is not final: the schedule starts anyway and the first check, and
  // every hourly one after it, reads the settings again and logs a failure. Unreadable settings
  // are treated as backups on, which is the data-safe side and what `readBackupSettings` does
  // for a stored value it cannot use.
  const settings = await readBackupSettings(opts.db, log).catch(() => undefined)
  if (settings !== undefined && !settings.enabled) {
    log.info({}, 'backups are off in app_config; no schedule started')
    return { stop: async () => {} }
  }

  let stopped = false
  let chain: Promise<void> = Promise.resolve()

  const check = async (preloaded?: BackupSettings): Promise<void> => {
    try {
      const current = preloaded ?? (await readBackupSettings(opts.db, log))
      if (!current.enabled) return
      if (!isDue(await listBackups(opts.outDir), current.intervalDays, now())) return
      const result = await dumpAndPrune(opts, current)
      log.info({ file: basename(result.path), dropped: result.dropped }, 'backup written')
    } catch (error: unknown) {
      log.error({ reason: describeError(error) }, 'backup failed')
    }
  }
  const enqueue = (preloaded?: BackupSettings): Promise<void> => {
    if (!stopped) chain = chain.then(() => check(preloaded))
    return chain
  }

  await sweepStalePartials(opts.outDir, now(), log)
  // An hourly poll and not one interval of `intervalDays`: see CHECK_EVERY_MS for why.
  const handle = timers.setInterval(() => void enqueue(), CHECK_EVERY_MS)
  await enqueue(settings)
  return {
    stop: async () => {
      if (!stopped) timers.clearInterval(handle)
      stopped = true
      await chain
    },
  }
}

/**
 * The schedule as a chassis dependency, started and stopped with the service that owns it.
 * `startService` does not use it: a dependency starts before the server listens, and the
 * schedule's first check can run a dump, which must not delay serving. `startService` starts
 * the schedule itself, after the server is up and without awaiting it.
 */
export function createBackupDependency(opts: BackupScheduleOptions): ReturnType<typeof createDependency> {
  let running: { stop(): Promise<void> } | undefined
  return createDependency({
    name: 'backup-schedule',
    onStart: async () => {
      running = await startBackupSchedule(opts)
    },
    onStop: async () => {
      await running?.stop()
      running = undefined
    },
  })
}

/** `bun run backup`: one dump and a prune, with the outcome on stdout and a failure on stderr. */
async function main(argv: readonly string[]): Promise<number> {
  if (!argv.includes('--once')) {
    process.stderr.write('usage: bun src/backup/schedule.ts --once\n')
    return 1
  }
  try {
    const result = await runBackupOnce({ db: getDb(), outDir: DEFAULT_BACKUP_DIR })
    process.stdout.write(`wrote ${basename(result.path)} to backups/ (${result.dropped} older removed)\n`)
    return 0
  } catch (error: unknown) {
    const reason = error instanceof MissingDatabaseUrlError ? error.message : describeError(error)
    process.stderr.write(`backup failed: ${reason}\n`)
    return 1
  } finally {
    await closeDb()
  }
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)))
}
