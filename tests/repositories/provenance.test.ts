import { describe, expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import postgres from 'postgres'

import type { DrizzleClient } from '../../src/data/client.ts'
import * as repositoryModule from '../../src/data/repositories/provenance.ts'
import {
  attachOrigin,
  getFirstTouch,
  listOrigins,
  recordOrigin,
  recordSearchRun,
  routeCounts,
  wasReposted,
} from '../../src/data/repositories/provenance.ts'
import { addPositions, type Position } from '../../src/data/repositories/positions.ts'
import { addRegistryRows, archiveRegistryRow } from '../../src/data/repositories/registries.ts'
import { position } from '../../src/data/schema/positions.ts'
import { origin } from '../../src/data/schema/provenance.ts'
import type { Origin } from '../../src/entities/provenance.ts'
import { ArchivedError, ConflictError, NotFoundError, statusFor } from '../../src/errors.ts'
import { firstTouch } from '../../src/provenance/first-touch.ts'
import {
  OriginBulkSchema,
  OriginInputSchema,
  SearchRunInputSchema,
} from '../../src/schemas/provenance.ts'
import { thrownBy } from '../data/rolled-back.ts'
import { withMigratedScratchDatabase } from '../data/scratch-database.ts'

/** The id at `index`, or a loud failure: an absent row would otherwise read as a pass. */
function idOf(rows: readonly { readonly id: number }[], index = 0): number {
  const id = rows[index]?.id
  if (id === undefined) throw new Error(`the arrangement produced no row at index ${index}`)
  return id
}

async function addPosition(db: DrizzleClient, title = 'Staff Engineer'): Promise<Position> {
  const [added] = await addPositions(db, [{ company: { name: `${title} Co` }, roleTitle: title }])
  if (!added) throw new Error('the arrangement stored no position')
  return added
}

async function addRoute(db: DrizzleClient, label: string): Promise<number> {
  return idOf(await addRegistryRows(db, 'route', [{ label }]))
}

/** The database's own clock, the one the view reads, so the function and the view share a "today". */
async function databaseNow(db: DrizzleClient): Promise<Date> {
  const rows = await db.execute<{ now: Date }>(sql`SELECT now() AS now`)
  return new Date(rows[0]?.now ?? '')
}

/**
 * A calendar day `offset` days from today in UTC, as `YYYY-MM-DD`, read from the database
 * clock: the view's "today" is that clock's, so a fixture dated from the JavaScript clock could
 * disagree with it for a moment around UTC midnight.
 */
async function dayFromToday(db: DrizzleClient, offset: number): Promise<string> {
  const rows = await db.execute<{ day: string }>(sql`SELECT ((now() AT TIME ZONE 'utc')::date + ${offset}::int)::text AS day`)
  return rows[0]?.day ?? ''
}

/**
 * Reads first touch both ways, from the view and from `firstTouch` over the position's rows
 * at the database's clock, and fails unless they agree. Returns the shared answer.
 */
async function firstTouchBothWays(db: DrizzleClient, positionId: number): Promise<Origin | null> {
  const fromView = await getFirstTouch(db, positionId)
  const fromFunction = firstTouch(await listOrigins(db, positionId), await databaseNow(db))
  expect(fromView).toEqual(fromFunction)
  return fromView
}

/** Polls until some backend is blocked on a lock, which is the moment the other transaction may commit. */
async function waitUntilABackendWaitsOnALock(observer: postgres.Sql): Promise<void> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const [row] = await observer`select count(*)::int as waiting from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()`
    if ((row?.waiting ?? 0) > 0) return
    await Bun.sleep(20)
  }
  throw new Error('no backend ever waited on a lock')
}

describe('recordOrigin', () => {
  test('stores a touch with no position, no route and no note as nulls', async () => {
    await withMigratedScratchDatabase(async (db) => {
      // Act
      const stored = await recordOrigin(db, { touchedOn: '2026-01-05' })

      // Assert
      expect(stored.positionId).toBeNull()
      expect(stored.routeId).toBeNull()
      expect(stored.note).toBeNull()
      expect(stored.searchRunId).toBeNull()
      expect(stored.touchedOn).toBe('2026-01-05')
      expect(stored.recordedAt).toBeInstanceOf(Date)
    })
  })

  test('keeps a future-dated touch as typed', async () => {
    await withMigratedScratchDatabase(async (db) => {
      const stored = await recordOrigin(db, { touchedOn: '2126-10-28' })
      expect(stored.touchedOn).toBe('2126-10-28')
    })
  })

  test('writes only the columns the allow-list names, even when the object carries more', async () => {
    await withMigratedScratchDatabase(async (db) => {
      // Arrange: an object that carries an id and a timestamp at run time
      const sneaky = { touchedOn: '2026-01-05', id: 999, recordedAt: new Date('2001-01-01T00:00:00Z') }

      // Act
      const stored = await recordOrigin(db, sneaky)

      // Assert
      expect(stored.id).not.toBe(999)
      expect(stored.recordedAt.getUTCFullYear()).toBeGreaterThan(2020)
    })
  })

  test('refuses an archived route, an unknown route, an unknown position and an unknown search run', async () => {
    await withMigratedScratchDatabase(async (db) => {
      // Arrange
      const routeId = await addRoute(db, 'corridor')
      await archiveRegistryRow(db, 'route', routeId)

      // Act
      const archived = await thrownBy(() => recordOrigin(db, { touchedOn: '2026-01-05', routeId }))
      const noRoute = await thrownBy(() => recordOrigin(db, { touchedOn: '2026-01-05', routeId: 9999 }))
      const noPosition = await thrownBy(() => recordOrigin(db, { touchedOn: '2026-01-05', positionId: 9999 }))
      const noRun = await thrownBy(() => recordOrigin(db, { touchedOn: '2026-01-05', searchRunId: 9999 }))
      const stored = await db.select().from(origin)

      // Assert
      expect(archived).toBeInstanceOf(ArchivedError)
      expect(noRoute).toBeInstanceOf(NotFoundError)
      expect(noPosition).toBeInstanceOf(NotFoundError)
      expect(noRun).toBeInstanceOf(NotFoundError)
      expect(statusFor(noPosition)).toBe(404)
      expect((noPosition as Error).message).not.toMatch(/insert|select|violates/i)
      expect((noPosition as Error).cause).toBeDefined()
      expect(stored).toHaveLength(0)
    })
  })

  test('attaches a touch to a position and a search run at once', async () => {
    await withMigratedScratchDatabase(async (db) => {
      // Arrange
      const target = await addPosition(db)
      const run = await recordSearchRun(db, { query: 'staff engineer remote', source: 'a job board' })

      // Act
      const stored = await recordOrigin(db, { positionId: target.id, searchRunId: run.id, touchedOn: '2026-01-05' })

      // Assert
      expect(stored.positionId).toBe(target.id)
      expect(stored.searchRunId).toBe(run.id)
    })
  })
})

describe('recordSearchRun', () => {
  test('stores the query, the source and when it ran', async () => {
    await withMigratedScratchDatabase(async (db) => {
      const run = await recordSearchRun(db, { query: 'staff engineer', source: 'a job board' })
      expect(run.query).toBe('staff engineer')
      expect(run.source).toBe('a job board')
      expect(run.ranAt).toBeInstanceOf(Date)
    })
  })
})

describe('getFirstTouch', () => {
  test('agrees with firstTouch over the same rows, and a backdated conversation wins', async () => {
    await withMigratedScratchDatabase(async (db) => {
      // Arrange: a query, a recruiter message, and a conversation from the 3rd entered last
      const target = await addPosition(db)
      const query = await recordOrigin(db, { positionId: target.id, touchedOn: '2026-01-10' })
      await recordOrigin(db, { positionId: target.id, touchedOn: '2026-01-12' })
      const conversation = await recordOrigin(db, { positionId: target.id, touchedOn: '2026-01-03' })

      // Act
      const shared = await firstTouchBothWays(db, target.id)

      // Assert
      expect(shared?.id).toBe(conversation.id)
      expect(shared?.id).not.toBe(query.id)
    })
  })

  test('breaks a same-day tie by when the row was recorded, then by id, as the function does', async () => {
    await withMigratedScratchDatabase(async (db) => {
      // Arrange: three touches on one day, recorded out of id order
      const target = await addPosition(db)
      const first = await recordOrigin(db, { positionId: target.id, touchedOn: '2026-01-10' })
      const second = await recordOrigin(db, { positionId: target.id, touchedOn: '2026-01-10' })
      const third = await recordOrigin(db, { positionId: target.id, touchedOn: '2026-01-10' })
      await db.update(origin).set({ recordedAt: new Date('2026-01-11T09:00:00Z') }).where(eq(origin.id, first.id))
      await db.update(origin).set({ recordedAt: new Date('2026-01-11T08:00:00Z') }).where(eq(origin.id, second.id))
      await db.update(origin).set({ recordedAt: new Date('2026-01-11T08:00:00Z') }).where(eq(origin.id, third.id))

      // Act
      const shared = await firstTouchBothWays(db, target.id)

      // Assert: the earlier recorded_at wins, and equal timestamps fall to the lower id
      expect(shared?.id).toBe(second.id)
    })
  })

  test('skips a future-dated origin: a position with only future origins has none, on both sides', async () => {
    await withMigratedScratchDatabase(async (db) => {
      // Arrange: the future dates are the earliest rows these positions have, so only the cutoff decides
      const lone = await addPosition(db, 'Lone')
      const several = await addPosition(db, 'Several')
      await recordOrigin(db, { positionId: lone.id, touchedOn: '2126-10-28' })
      await recordOrigin(db, { positionId: several.id, touchedOn: '2126-10-28' })
      await recordOrigin(db, { positionId: several.id, touchedOn: '2127-01-01' })

      // Act / Assert
      expect(await firstTouchBothWays(db, lone.id)).toBeNull()
      expect(await firstTouchBothWays(db, several.id)).toBeNull()
      expect(await listOrigins(db, lone.id)).toHaveLength(1)
    })
  })

  test('a future-dated origin entered first does not displace a real touch dated today, on both sides', async () => {
    await withMigratedScratchDatabase(async (db) => {
      // Arrange: the typo was entered first (lower id, earlier recorded_at). `touchedOn` is the
      // leading sort key, so the typo loses on the first comparison and this test does not
      // isolate the cutoff: the future-only fixtures above, where no other row exists, carry that.
      // What it checks is that entry order never lets a mistyped date win over a real one.
      const target = await addPosition(db)
      const typo = await recordOrigin(db, { positionId: target.id, touchedOn: '2126-10-28' })
      const real = await recordOrigin(db, { positionId: target.id, touchedOn: await dayFromToday(db, 0) })
      await db.update(origin).set({ recordedAt: new Date('2020-01-01T00:00:00Z') }).where(eq(origin.id, typo.id))

      // Act
      const shared = await firstTouchBothWays(db, target.id)

      // Assert
      expect(typo.id).toBeLessThan(real.id)
      expect(shared?.id).toBe(real.id)
    })
  })

  test('counts an origin dated today and skips a future one beside it, on both sides', async () => {
    await withMigratedScratchDatabase(async (db) => {
      const target = await addPosition(db)
      const today = await recordOrigin(db, { positionId: target.id, touchedOn: await dayFromToday(db, 0) })
      await recordOrigin(db, { positionId: target.id, touchedOn: await dayFromToday(db, 400) })

      expect((await firstTouchBothWays(db, target.id))?.id).toBe(today.id)
    })
  })

  test('counts an origin dated today when it is the only one, on both sides', async () => {
    await withMigratedScratchDatabase(async (db) => {
      const target = await addPosition(db)
      const today = await recordOrigin(db, { positionId: target.id, touchedOn: await dayFromToday(db, 0) })

      expect((await firstTouchBothWays(db, target.id))?.id).toBe(today.id)
    })
  })

  test('skips tomorrow: the day after today is the first one the cutoff refuses', async () => {
    await withMigratedScratchDatabase(async (db) => {
      const target = await addPosition(db)
      await recordOrigin(db, { positionId: target.id, touchedOn: await dayFromToday(db, 1) })

      expect(await firstTouchBothWays(db, target.id)).toBeNull()
    })
  })

  test('is null for a position that has no origin, and NotFoundError for one that does not exist', async () => {
    await withMigratedScratchDatabase(async (db) => {
      const target = await addPosition(db)
      expect(await getFirstTouch(db, target.id)).toBeNull()
      expect(await thrownBy(() => getFirstTouch(db, 9999))).toBeInstanceOf(NotFoundError)
    })
  })
})

describe('an origin with no position', () => {
  test('may exist and attach later, and then counts as the first touch', async () => {
    await withMigratedScratchDatabase(async (db) => {
      // Arrange: a meetup conversation logged before any posting existed
      const routeId = await addRoute(db, 'meetup')
      const floating = await recordOrigin(db, { routeId, touchedOn: '2026-01-03', note: 'Dana mentioned an opening' })
      const target = await addPosition(db)
      const board = await recordOrigin(db, { positionId: target.id, touchedOn: '2026-01-10' })
      const before = await getFirstTouch(db, target.id)

      // Act
      const attached = await attachOrigin(db, floating.id, target.id)
      const after = await getFirstTouch(db, target.id)

      // Assert
      expect(floating.positionId).toBeNull()
      expect(before?.id).toBe(board.id)
      expect(attached.positionId).toBe(target.id)
      expect(attached.note).toBe('Dana mentioned an opening')
      expect(after?.id).toBe(floating.id)
      expect((await listOrigins(db, target.id)).map((row) => row.id)).toEqual([floating.id, board.id])
    })
  })

  test('attaching twice to the same position is harmless, and to another position is a ConflictError', async () => {
    await withMigratedScratchDatabase(async (db) => {
      // Arrange
      const one = await addPosition(db, 'One')
      const other = await addPosition(db, 'Other')
      const floating = await recordOrigin(db, { touchedOn: '2026-01-03' })
      await attachOrigin(db, floating.id, one.id)

      // Act
      const again = await attachOrigin(db, floating.id, one.id)
      const elsewhere = await thrownBy(() => attachOrigin(db, floating.id, other.id))

      // Assert
      expect(again.positionId).toBe(one.id)
      expect(elsewhere).toBeInstanceOf(ConflictError)
      expect(statusFor(elsewhere)).toBe(409)
      expect((await listOrigins(db, other.id))).toHaveLength(0)
    })
  })

  test('two callers attaching one origin to different positions cannot both succeed', async () => {
    // Arrange / Act: another connection attaches it to one position and holds that open, so the
    // attach to the other position waits on the row, then re-reads it once the first commits
    const { error, rows, firstId } = await withMigratedScratchDatabase(async (db, sql) => {
      const url = new URL(process.env.DATABASE_URL ?? '')
      url.pathname = `/${sql.options.database}`
      const writer = postgres(url.toString(), { max: 1, onnotice: () => {} })
      const observer = postgres(url.toString(), { max: 1, onnotice: () => {} })
      try {
        const winner = await addPosition(db, 'Winner')
        const loser = await addPosition(db, 'Loser')
        const floating = await recordOrigin(db, { touchedOn: '2026-01-03' })
        let attempt: Promise<unknown> = Promise.resolve()
        await writer.begin(async (transaction) => {
          await transaction`update origin set position_id = ${winner.id} where id = ${floating.id}`
          attempt = thrownBy(() => attachOrigin(db, floating.id, loser.id))
          await waitUntilABackendWaitsOnALock(observer)
        })
        const error = await attempt
        const rows = await observer`select position_id from origin where id = ${floating.id}`
        return { error, rows: rows.map((row) => row.position_id), firstId: winner.id }
      } finally {
        await writer.end()
        await observer.end()
      }
    })

    // Assert: the second caller saw the committed attach and was refused; the origin stayed put
    expect(error).toBeInstanceOf(ConflictError)
    expect(rows).toEqual([firstId])
  })

  test('refuses an origin or a position that does not exist', async () => {
    await withMigratedScratchDatabase(async (db) => {
      // Arrange
      const target = await addPosition(db)
      const floating = await recordOrigin(db, { touchedOn: '2026-01-03' })

      // Act
      const noOrigin = await thrownBy(() => attachOrigin(db, 9999, target.id))
      const noPosition = await thrownBy(() => attachOrigin(db, floating.id, 9999))
      const stillFloating = await db.select().from(origin).where(eq(origin.id, floating.id))

      // Assert
      expect(noOrigin).toBeInstanceOf(NotFoundError)
      expect(noPosition).toBeInstanceOf(NotFoundError)
      expect((noPosition as Error).message).not.toMatch(/update|select|violates/i)
      expect((noPosition as Error).cause).toBeDefined()
      expect(stillFloating[0]?.positionId).toBeNull()
    })
  })

  test('is what deleting a position leaves behind: its origins, unattached', async () => {
    await withMigratedScratchDatabase(async (db) => {
      // Arrange
      const target = await addPosition(db)
      const touch = await recordOrigin(db, { positionId: target.id, touchedOn: '2026-01-05' })

      // Act
      await db.delete(position).where(eq(position.id, target.id))
      const left = await db.select().from(origin).where(eq(origin.id, touch.id))

      // Assert
      expect(left).toHaveLength(1)
      expect(left[0]?.positionId).toBeNull()
    })
  })
})

describe('listOrigins', () => {
  test('lists a position\'s origins in first-touch order, and a missing position is NotFoundError', async () => {
    await withMigratedScratchDatabase(async (db) => {
      const target = await addPosition(db)
      const late = await recordOrigin(db, { positionId: target.id, touchedOn: '2026-01-12' })
      const early = await recordOrigin(db, { positionId: target.id, touchedOn: '2026-01-03' })
      const empty = await addPosition(db, 'Empty')

      expect((await listOrigins(db, target.id)).map((row) => row.id)).toEqual([early.id, late.id])
      expect(await listOrigins(db, empty.id)).toEqual([])
      expect(await thrownBy(() => listOrigins(db, 9999))).toBeInstanceOf(NotFoundError)
    })
  })
})

describe('routeCounts', () => {
  test('counts a position once per route it was reached through', async () => {
    await withMigratedScratchDatabase(async (db) => {
      // Arrange: A is reached through the board twice and a friend once; B only through the board
      const board = await addRoute(db, 'board')
      const friend = await addRoute(db, 'friend')
      const a = await addPosition(db, 'A')
      const b = await addPosition(db, 'B')
      await recordOrigin(db, { positionId: a.id, routeId: board, touchedOn: '2026-01-05' })
      await recordOrigin(db, { positionId: a.id, routeId: board, touchedOn: '2026-01-09' })
      await recordOrigin(db, { positionId: a.id, routeId: friend, touchedOn: '2026-01-03' })
      await recordOrigin(db, { positionId: b.id, routeId: board, touchedOn: '2026-01-06' })

      // Act
      const counts = await routeCounts(db)

      // Assert
      expect(counts).toEqual([
        { routeId: board, routeLabel: 'board', positions: 2 },
        { routeId: friend, routeLabel: 'friend', positions: 1 },
      ])
    })
  })

  test('groups touches with no route under a null route, and leaves out touches with no position', async () => {
    await withMigratedScratchDatabase(async (db) => {
      // Arrange
      const board = await addRoute(db, 'board')
      const a = await addPosition(db, 'A')
      await recordOrigin(db, { positionId: a.id, touchedOn: '2026-01-05' })
      await recordOrigin(db, { routeId: board, touchedOn: '2026-01-05' })

      // Act
      const counts = await routeCounts(db)

      // Assert
      expect(counts).toEqual([{ routeId: null, routeLabel: null, positions: 1 }])
    })
  })

  test('still renders the label of a route archived after positions were reached through it', async () => {
    await withMigratedScratchDatabase(async (db) => {
      const board = await addRoute(db, 'board')
      const a = await addPosition(db, 'A')
      await recordOrigin(db, { positionId: a.id, routeId: board, touchedOn: '2026-01-05' })
      await archiveRegistryRow(db, 'route', board)

      expect(await routeCounts(db)).toEqual([{ routeId: board, routeLabel: 'board', positions: 1 }])
    })
  })

  test('is empty on a fresh install and orders the busiest route first', async () => {
    await withMigratedScratchDatabase(async (db) => {
      expect(await routeCounts(db)).toEqual([])
      const quiet = await addRoute(db, 'quiet')
      const busy = await addRoute(db, 'busy')
      const a = await addPosition(db, 'A')
      const b = await addPosition(db, 'B')
      await recordOrigin(db, { positionId: a.id, routeId: quiet, touchedOn: '2026-01-05' })
      await recordOrigin(db, { positionId: a.id, routeId: busy, touchedOn: '2026-01-05' })
      await recordOrigin(db, { positionId: b.id, routeId: busy, touchedOn: '2026-01-05' })

      expect((await routeCounts(db)).map((row) => row.routeId)).toEqual([busy, quiet])
    })
  })
})

describe('wasReposted', () => {
  test('is false for no origin and for one, true for two, and NotFoundError for a missing position', async () => {
    await withMigratedScratchDatabase(async (db) => {
      // Arrange
      const target = await addPosition(db)
      const none = await wasReposted(db, target.id)
      await recordOrigin(db, { positionId: target.id, touchedOn: '2026-01-05' })
      const one = await wasReposted(db, target.id)

      // Act
      await recordOrigin(db, { positionId: target.id, touchedOn: '2026-02-05' })
      const two = await wasReposted(db, target.id)

      // Assert
      expect([none, one, two]).toEqual([false, false, true])
      expect(await thrownBy(() => wasReposted(db, 9999))).toBeInstanceOf(NotFoundError)
    })
  })
})

describe('the module', () => {
  test('exports no second copy of the checks Tasks 4 and 7 own', () => {
    expect(Object.keys(repositoryModule)).not.toContain('isApplied')
    expect(Object.keys(repositoryModule)).not.toContain('summaryChanged')
  })
})

describe('the provenance input schemas', () => {
  test('an origin input needs a real calendar day and refuses unknown keys, NUL and an empty note', () => {
    expect(OriginInputSchema.parse({ touchedOn: '2026-01-05' })).toEqual({ touchedOn: '2026-01-05' })
    expect(OriginInputSchema.safeParse({}).success).toBe(false)
    expect(OriginInputSchema.safeParse({ touchedOn: '2026-02-30' }).success).toBe(false)
    expect(OriginInputSchema.safeParse({ touchedOn: '2026-01-05', recordedAt: '2020-01-01' }).success).toBe(false)
    expect(OriginInputSchema.safeParse({ touchedOn: '2026-01-05', note: 'a\u0000b' }).success).toBe(false)
    expect(OriginInputSchema.safeParse({ touchedOn: '2026-01-05', note: '   ' }).success).toBe(false)
  })

  test('ids arrive as numbers or numeric text, and null clears a reference', () => {
    expect(OriginInputSchema.parse({ touchedOn: '2026-01-05', positionId: '4', routeId: null })).toEqual({
      touchedOn: '2026-01-05',
      positionId: 4,
      routeId: null,
    })
    expect(OriginInputSchema.safeParse({ touchedOn: '2026-01-05', positionId: 0 }).success).toBe(false)
  })

  test('a search run needs a query and a source, free of NUL', () => {
    expect(SearchRunInputSchema.parse({ query: ' staff ', source: 'a board' })).toEqual({ query: 'staff', source: 'a board' })
    expect(SearchRunInputSchema.safeParse({ query: '', source: 'a board' }).success).toBe(false)
    expect(SearchRunInputSchema.safeParse({ query: 'q', source: 'a\u0000' }).success).toBe(false)
    expect(SearchRunInputSchema.safeParse({ query: 'q', source: 's', extra: 1 }).success).toBe(false)
  })

  test('the bulk forms take a bounded, non-empty list', () => {
    expect(OriginBulkSchema.safeParse({ items: [] }).success).toBe(false)
    expect(OriginBulkSchema.safeParse({ items: [{ touchedOn: '2026-01-05' }] }).success).toBe(true)
  })
})
