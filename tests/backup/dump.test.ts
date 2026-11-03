import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BackupDumpError, createBunSpawner, runDump, type SpawnRequest, type SpawnResult, type Spawner } from '../../src/backup/dump.ts'

const PASSWORD_RAW = 's3cret/pw@x'
const URL_UNDER_TEST = `postgres://backup_user:${encodeURIComponent(PASSWORD_RAW)}@db.example.test:5433/tracker_db?sslmode=require`
const NOW = new Date('2026-11-03T09:05:07Z')

let outDir: string

beforeEach(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'backup-test-'))
})

afterEach(async () => {
  await rm(outDir, { recursive: true, force: true })
})

/** The path a dump was asked to write, read from the `--file=` argument the way pg_dump would. */
function targetOf(request: SpawnRequest): string {
  const arg = request.args.find((candidate) => candidate.startsWith('--file='))
  if (!arg) throw new Error('no --file argument')
  return arg.slice('--file='.length)
}

/** A stand-in for pg_dump: records the request, writes a small file where it was told to, and exits 0. */
function succeedingSpawner(calls: SpawnRequest[] = []): Spawner {
  return async (request) => {
    calls.push(request)
    await writeFile(targetOf(request), 'PGDMP-stand-in')
    return { exitCode: 0, signal: null, stderr: '' }
  }
}

const failing = (result: SpawnResult): Spawner => async (request) => {
  await writeFile(targetOf(request), 'half a dump')
  return result
}

describe('runDump', () => {
  test('names the file with a sortable UTC timestamp', async () => {
    const path = await runDump({ databaseUrl: URL_UNDER_TEST, outDir, now: NOW, spawn: succeedingSpawner() })

    expect(path).toBe(join(outDir, 'tracker-20261103T090507Z.dump'))
    expect(await readFile(path, 'utf8')).toBe('PGDMP-stand-in')
    expect(await readdir(outDir)).toEqual(['tracker-20261103T090507Z.dump'])
  })

  test('passes the connection to the binary through its environment and never logs it', async () => {
    // Arrange
    const calls: SpawnRequest[] = []
    const spies = [
      spyOn(console, 'log'),
      spyOn(console, 'info'),
      spyOn(console, 'warn'),
      spyOn(console, 'error'),
      spyOn(process.stdout, 'write'),
      spyOn(process.stderr, 'write'),
    ]

    // Act
    const path = await runDump({ databaseUrl: URL_UNDER_TEST, outDir, now: NOW, spawn: succeedingSpawner(calls) })
    const writes = spies.map((spy) => spy.mock.calls.length)
    spies.forEach((spy) => spy.mockRestore())

    // Assert: the credentials arrive as variables, decoded
    const [request] = calls
    expect(request?.env).toMatchObject({
      PGHOST: 'db.example.test',
      PGPORT: '5433',
      PGUSER: 'backup_user',
      PGPASSWORD: PASSWORD_RAW,
      PGDATABASE: 'tracker_db',
      PGSSLMODE: 'require',
    })
    // ...and appear nowhere a process list, a log or a path would show them
    const visible = JSON.stringify([request?.command, request?.args, path])
    expect(visible).not.toContain(URL_UNDER_TEST)
    expect(visible).not.toContain('s3cret')
    expect(visible).not.toContain(encodeURIComponent(PASSWORD_RAW))
    expect(visible).not.toContain('backup_user')
    expect(writes).toEqual([0, 0, 0, 0, 0, 0])
  })

  test('uses PG_DUMP_BIN for the binary, and pg_dump when it is unset', async () => {
    const original = process.env.PG_DUMP_BIN
    try {
      const calls: SpawnRequest[] = []
      delete process.env.PG_DUMP_BIN
      await runDump({ databaseUrl: URL_UNDER_TEST, outDir, now: NOW, spawn: succeedingSpawner(calls) })
      process.env.PG_DUMP_BIN = '/opt/somewhere/pg_dump'
      await runDump({ databaseUrl: URL_UNDER_TEST, outDir, now: new Date('2026-11-04T00:00:00Z'), spawn: succeedingSpawner(calls) })

      expect(calls.map((call) => call.command)).toEqual(['pg_dump', '/opt/somewhere/pg_dump'])
    } finally {
      if (original === undefined) delete process.env.PG_DUMP_BIN
      else process.env.PG_DUMP_BIN = original
    }
  })

  test('creates the directory private to its owner and leaves the dump readable by the owner alone', async () => {
    const nested = join(outDir, 'a', 'b')

    const path = await runDump({ databaseUrl: URL_UNDER_TEST, outDir: nested, now: NOW, spawn: succeedingSpawner() })

    expect((await stat(nested)).mode & 0o077).toBe(0)
    expect((await stat(path)).mode & 0o077).toBe(0)
  })

  test("raises when the child exits non-zero, with the child's stderr and no URL", async () => {
    // Arrange: a stderr that, like a careless tool, repeats the connection it was given
    const stderr = `pg_dump: error: connection to server failed: ${URL_UNDER_TEST} password ${PASSWORD_RAW}`
    const spawn = failing({ exitCode: 1, signal: null, stderr })

    // Act
    const error = await runDump({ databaseUrl: URL_UNDER_TEST, outDir, now: NOW, spawn }).then(
      () => undefined,
      (caught: unknown) => caught,
    )

    // Assert
    expect(error).toBeInstanceOf(BackupDumpError)
    const message = (error as Error).message
    expect(message).toContain('exited with code 1')
    expect(message).toContain('pg_dump: error: connection to server failed')
    expect(message).not.toContain('s3cret')
    expect(message).not.toContain('backup_user')
    expect(message).not.toContain(URL_UNDER_TEST)
  })

  test('removes the half-written file when the dump fails, so it is never taken for a backup', async () => {
    const spawn = failing({ exitCode: 1, signal: null, stderr: 'boom' })

    await runDump({ databaseUrl: URL_UNDER_TEST, outDir, now: NOW, spawn }).catch(() => undefined)

    expect(await readdir(outDir)).toEqual([])
  })

  test('reports a child stopped by a signal as that, not as an exit code', async () => {
    const spawn = failing({ exitCode: null, signal: 'SIGKILL', stderr: '' })

    const error = await runDump({ databaseUrl: URL_UNDER_TEST, outDir, now: NOW, spawn }).then(
      () => undefined,
      (caught: unknown) => caught,
    )

    expect((error as Error).message).toContain('SIGKILL')
    expect((error as Error).message).not.toContain('exited with code')
  })

  test('redacts the URL from an error the spawner itself throws', async () => {
    const spawn: Spawner = async () => {
      throw new Error(`could not start for ${URL_UNDER_TEST}`)
    }

    const error = await runDump({ databaseUrl: URL_UNDER_TEST, outDir, now: NOW, spawn }).then(
      () => undefined,
      (caught: unknown) => caught,
    )

    expect(error).toBeInstanceOf(BackupDumpError)
    expect((error as Error).message).not.toContain('s3cret')
    expect((error as Error).message).not.toContain(URL_UNDER_TEST)
  })

  test('redacts before it truncates, so a URL straddling the cut leaves no fragment of the credential', async () => {
    // Arrange: a stand-in whose stderr puts the URL across the 4,000-character mark of the message
    const scriptDir = await mkdtemp(join(tmpdir(), 'backup-straddle-'))
    const script = join(scriptDir, 'pg_dump')
    const padding = 'x'.repeat(4_000 - 26)
    await writeFile(script, `#!/bin/sh\n/bin/echo "${padding}${URL_UNDER_TEST}" >&2\nexit 1\n`, { mode: 0o755 })
    const original = process.env.PG_DUMP_BIN
    process.env.PG_DUMP_BIN = script

    try {
      // Act
      const error = await runDump({ databaseUrl: URL_UNDER_TEST, outDir, now: NOW, spawn: createBunSpawner() }).then(
        () => undefined,
        (caught: unknown) => caught,
      )

      // Assert: 26 characters of the URL would have survived a cut-then-redact ("postgres://backup_user:s3c")
      const message = (error as Error).message
      expect(message).toContain('exited with code 1')
      expect(message).not.toContain('backup_user')
      expect(message).not.toContain('s3c')
      expect(message).not.toContain('postgres://')
    } finally {
      if (original === undefined) delete process.env.PG_DUMP_BIN
      else process.env.PG_DUMP_BIN = original
      await rm(scriptDir, { recursive: true, force: true })
    }
  })

  test('raises when a successful exit left no file behind', async () => {
    const spawn: Spawner = async () => ({ exitCode: 0, signal: null, stderr: '' })

    await expect(runDump({ databaseUrl: URL_UNDER_TEST, outDir, now: NOW, spawn })).rejects.toThrow(/wrote no file/)
  })

  test('refuses an unusable URL without repeating it, and without starting the binary', async () => {
    const calls: SpawnRequest[] = []
    const notAUrl = 'not a url with secret-token-123'

    const error = await runDump({ databaseUrl: notAUrl, outDir, now: NOW, spawn: succeedingSpawner(calls) }).then(
      () => undefined,
      (caught: unknown) => caught,
    )

    expect(error).toBeInstanceOf(BackupDumpError)
    expect((error as Error).message).not.toContain('secret-token-123')
    expect(calls).toEqual([])
  })
})

describe('createBunSpawner, with a stand-in script for the binary', () => {
  let scriptDir: string

  beforeEach(async () => {
    scriptDir = await mkdtemp(join(tmpdir(), 'backup-stand-in-'))
  })

  afterEach(async () => {
    await rm(scriptDir, { recursive: true, force: true })
  })

  /** A `#!/bin/sh` script that stands in for pg_dump; every tool inside is named absolutely. */
  async function standIn(body: string): Promise<string> {
    const path = join(scriptDir, 'pg_dump')
    await writeFile(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
    return path
  }

  test("returns the child's exit code and stderr", async () => {
    const command = await standIn('/bin/echo "pg_dump: error: no such database" >&2\nexit 3')

    const result = await createBunSpawner()({ command, args: [], env: {} })

    expect(result).toEqual({ exitCode: 3, signal: null, stderr: 'pg_dump: error: no such database\n' })
  })

  test('reads a killed child as a signal, not as 128 plus the signal', async () => {
    const command = await standIn('kill -KILL $$')

    const result = await createBunSpawner()({ command, args: [], env: {} })

    expect(result.signal).toBe('SIGKILL')
    expect(result.exitCode).toBeNull()
  })

  test('passes the environment it is given to the child, and only that and PATH', async () => {
    const command = await standIn('/bin/echo "$PGUSER:${HOME:-unset}" >&2')

    const result = await createBunSpawner()({ command, args: [], env: { PGUSER: 'someone' } })

    expect(result.stderr).toBe('someone:unset\n')
  })

  test('stops a child that outlives the timeout, and does not return until it is dead', async () => {
    const markerPath = join(scriptDir, 'still-running')
    const command = await standIn(`/bin/sleep 0.6\n/usr/bin/touch "${markerPath}"`)

    const result = await createBunSpawner({ timeoutMs: 100 })({ command, args: [], env: {} })
    await new Promise((resolve) => setTimeout(resolve, 900))

    expect(result.signal).toBe('SIGTERM')
    expect(existsSync(markerPath)).toBe(false)
  })

  test('kills with SIGKILL a child that ignores the SIGTERM sent at the timeout, so it cannot wedge the caller', async () => {
    const command = await standIn('trap "" TERM\nwhile :; do /bin/sleep 0.1; done')
    const started = Date.now()

    const result = await createBunSpawner({ timeoutMs: 1000, killGraceMs: 300, drainMs: 100 })({ command, args: [], env: {} })

    // the timeout is long enough for a freshly written script to have installed its trap
    expect(result.signal).toBe('SIGKILL')
    expect(Date.now() - started).toBeLessThan(4000)
  })

  test('does not wait for a grandchild that still holds the stderr pipe', async () => {
    const command = await standIn('/bin/sleep 3 &\nexit 0')
    const started = Date.now()

    const result = await createBunSpawner({ drainMs: 100 })({ command, args: [], env: {} })

    expect(result.exitCode).toBe(0)
    expect(Date.now() - started).toBeLessThan(2000)
  })

  test('raises, without the arguments, when the binary cannot be started', async () => {
    const missing = join(scriptDir, 'absent')

    await expect(createBunSpawner()({ command: missing, args: ['--secret-looking-arg'], env: {} })).rejects.toThrow(/could not be started/)
    await createBunSpawner()({ command: missing, args: ['--secret-looking-arg'], env: {} }).catch((error: Error) => {
      expect(error.message).not.toContain('secret-looking-arg')
    })
  })
})
