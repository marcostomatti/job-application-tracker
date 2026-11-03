import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createBackupDependency, runBackupOnce, startBackupSchedule, type BackupTimers } from '../../src/backup/schedule.ts'
import type { SpawnRequest, Spawner } from '../../src/backup/dump.ts'
import { setBackupSettings } from '../../src/data/repositories/config.ts'
import type { Db } from '../../src/data/repositories/db.ts'
import { withMigratedScratchDatabase } from '../data/scratch-database.ts'

const NOW = new Date('2026-11-03T09:05:07Z')
const NEW_DUMP = 'tracker-20261103T090507Z.dump'
const URL_UNDER_TEST = 'postgres://backup_user:s3cret@db.example.test:5433/tracker_db'

let outDir: string

beforeEach(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'backup-schedule-'))
})

afterEach(async () => {
  await rm(outDir, { recursive: true, force: true })
})

/** The directory's entries in a fixed order, because `readdir` promises none. */
async function listing(): Promise<string[]> {
  return (await readdir(outDir)).sort()
}

/** Dumps already on disk, named as `runDump` names them. */
async function seedDumps(...names: string[]): Promise<void> {
  await Promise.all(names.map((name) => writeFile(join(outDir, name), 'old dump')))
}

function recordingSpawner(calls: SpawnRequest[]): Spawner {
  return async (request) => {
    calls.push(request)
    const target = request.args.find((arg) => arg.startsWith('--file='))?.slice('--file='.length)
    if (target) await writeFile(target, 'new dump')
    return { exitCode: 0, signal: null, stderr: '' }
  }
}

type FakeTimers = BackupTimers & {
  readonly started: { readonly run: () => void; readonly ms: number }[]
  readonly cleared: unknown[]
}

function fakeTimers(): FakeTimers {
  const started: FakeTimers['started'] = []
  const cleared: unknown[] = []
  return {
    started,
    cleared,
    setInterval: (run, ms) => {
      started.push({ run, ms })
      return started.length
    },
    clearInterval: (handle) => {
      cleared.push(handle)
    },
  }
}

const silent = { info: () => {}, warn: () => {}, error: () => {} }

function start(db: Db, extra: Partial<Parameters<typeof startBackupSchedule>[0]> = {}) {
  const calls: SpawnRequest[] = []
  const timers = fakeTimers()
  const options = { db, outDir, spawn: recordingSpawner(calls), databaseUrl: URL_UNDER_TEST, now: () => NOW, timers, logger: silent, ...extra }
  return { calls, timers, started: startBackupSchedule(options) }
}

describe('startBackupSchedule', () => {
  test('starts no timer and runs no dump when enabled is false', async () => {
    await withMigratedScratchDatabase(async (db) => {
      await setBackupSettings(db, { enabled: false })
      const { calls, timers, started } = start(db)

      const handle = await started
      await handle.stop()

      expect(timers.started).toEqual([])
      expect(timers.cleared).toEqual([])
      expect(calls).toEqual([])
    })
  })

  test('reads keep and interval from app_config: a dump is due after the interval, and only keep files stay', async () => {
    await withMigratedScratchDatabase(async (db) => {
      await setBackupSettings(db, { keep: 2, intervalDays: 3 })
      await seedDumps('tracker-20260920T000000Z.dump', 'tracker-20261001T000000Z.dump', 'tracker-20261030T090507Z.dump')
      const { calls, started } = start(db)

      await (await started).stop()

      // newest is 4 days old and the interval is 3, so a dump was made; keep = 2 leaves it and the previous newest
      expect(calls).toHaveLength(1)
      expect(await listing()).toEqual(['tracker-20261030T090507Z.dump', NEW_DUMP])
    })
  })

  test('makes no dump while the newest is younger than the interval', async () => {
    await withMigratedScratchDatabase(async (db) => {
      await setBackupSettings(db, { keep: 2, intervalDays: 3 })
      await seedDumps('tracker-20261101T090507Z.dump')
      const { calls, started } = start(db)

      await (await started).stop()

      expect(calls).toEqual([])
      expect(await listing()).toEqual(['tracker-20261101T090507Z.dump'])
    })
  })

  test('defaults to one kept dump a fortnight apart when nothing is stored, and the first start makes one', async () => {
    await withMigratedScratchDatabase(async (db) => {
      await seedDumps('tracker-20261001T000000Z.dump')
      const { calls, started } = start(db)

      await (await started).stop()

      expect(calls).toHaveLength(1)
      expect(await listing()).toEqual([NEW_DUMP])
    })
  })

  test('arms one timer that checks well inside any interval, and stop() clears it', async () => {
    await withMigratedScratchDatabase(async (db) => {
      const { timers, started } = start(db)

      const handle = await started
      expect(timers.started).toHaveLength(1)
      // timer delays above 2^31 - 1 ms fire at once, so a check period must stay far below it
      expect(timers.started[0]?.ms).toBeLessThanOrEqual(2 ** 31 - 1)
      expect(timers.cleared).toEqual([])
      await handle.stop()

      expect(timers.cleared).toEqual([1])
    })
  })

  test('a timer tick makes a dump once the interval has passed', async () => {
    await withMigratedScratchDatabase(async (db) => {
      await setBackupSettings(db, { intervalDays: 1 })
      await seedDumps('tracker-20261103T000000Z.dump')
      let current = NOW
      const { calls, timers, started } = start(db, { now: () => current })
      const handle = await started

      current = new Date('2026-11-05T00:00:00Z')
      timers.started[0]?.run()
      await handle.stop()

      expect(calls).toHaveLength(1)
    })
  })

  test('a timer tick rereads the settings, so switching backups off takes effect without a restart', async () => {
    await withMigratedScratchDatabase(async (db) => {
      await setBackupSettings(db, { intervalDays: 1 })
      await seedDumps('tracker-20261103T000000Z.dump')
      let current = NOW
      const { calls, timers, started } = start(db, { now: () => current })
      const handle = await started

      current = new Date('2026-11-05T00:00:00Z')
      await setBackupSettings(db, { enabled: false })
      timers.started[0]?.run()
      await handle.stop()

      expect(calls).toEqual([])
    })
  })

  test('a failing dump is logged without the URL and does not stop the schedule or throw', async () => {
    await withMigratedScratchDatabase(async (db) => {
      const logged: string[] = []
      const logger = {
        info: (context: object, message: string) => logged.push(JSON.stringify([context, message])),
        warn: (context: object, message: string) => logged.push(JSON.stringify([context, message])),
        error: (context: object, message: string) => logged.push(JSON.stringify([context, message])),
      }
      const spawn: Spawner = async () => ({ exitCode: 1, signal: null, stderr: `connect failed ${URL_UNDER_TEST}` })
      const { started } = start(db, { spawn, logger })

      const handle = await started
      await handle.stop()

      const text = logged.join('\n')
      expect(text).toContain('connect failed')
      expect(text).not.toContain('s3cret')
      expect(text).not.toContain(URL_UNDER_TEST)
    })
  })
})

describe('runBackupOnce', () => {
  test('dumps now whatever the interval says, then prunes to keep', async () => {
    await withMigratedScratchDatabase(async (db) => {
      await setBackupSettings(db, { keep: 1 })
      await seedDumps('tracker-20261103T090000Z.dump', 'tracker-20261102T000000Z.dump')
      const calls: SpawnRequest[] = []

      const result = await runBackupOnce({ db, outDir, spawn: recordingSpawner(calls), databaseUrl: URL_UNDER_TEST, now: () => NOW, logger: silent })

      expect(result.path).toBe(join(outDir, NEW_DUMP))
      expect(result.dropped).toBe(2)
      expect(await listing()).toEqual([NEW_DUMP])
    })
  })

  test('leaves files that are not backups alone', async () => {
    await withMigratedScratchDatabase(async (db) => {
      await writeFile(join(outDir, 'notes.txt'), 'keep me')
      await seedDumps('tracker-20261001T000000Z.dump')

      await runBackupOnce({ db, outDir, spawn: recordingSpawner([]), databaseUrl: URL_UNDER_TEST, now: () => NOW, logger: silent })

      expect(await listing()).toEqual(['notes.txt', NEW_DUMP])
    })
  })

  test('a failed dump prunes nothing, so the last good backup survives', async () => {
    await withMigratedScratchDatabase(async (db) => {
      await seedDumps('tracker-20261001T000000Z.dump')
      const spawn: Spawner = async () => ({ exitCode: 1, signal: null, stderr: 'boom' })

      await runBackupOnce({ db, outDir, spawn, databaseUrl: URL_UNDER_TEST, now: () => NOW, logger: silent }).catch(() => undefined)

      expect(await listing()).toEqual(['tracker-20261001T000000Z.dump'])
    })
  })

  test('refuses to run without a database URL, naming the variable', async () => {
    await withMigratedScratchDatabase(async (db) => {
      const original = process.env.DATABASE_URL
      delete process.env.DATABASE_URL
      try {
        await expect(runBackupOnce({ db, outDir, spawn: recordingSpawner([]), now: () => NOW, logger: silent })).rejects.toThrow(/DATABASE_URL/)
      } finally {
        if (original !== undefined) process.env.DATABASE_URL = original
      }
    })
  })
})

describe('createBackupDependency', () => {
  test('starts the schedule on start and clears its timer on stop', async () => {
    await withMigratedScratchDatabase(async (db) => {
      const timers = fakeTimers()
      const dependency = createBackupDependency({ db, outDir, spawn: recordingSpawner([]), databaseUrl: URL_UNDER_TEST, now: () => NOW, timers, logger: silent })

      await dependency.start()
      expect(dependency.status).toBe('running')
      expect(timers.started).toHaveLength(1)
      await dependency.stop()

      expect(dependency.status).toBe('stopped')
      expect(timers.cleared).toEqual([1])
    })
  })
})
