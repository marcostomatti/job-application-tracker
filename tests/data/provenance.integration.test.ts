import { afterAll, describe, expect, test } from 'bun:test'
import { asc, eq, isNull, sql } from 'drizzle-orm'

import { closeDb } from '../../src/data/client.ts'
import { origin, postingFirstTouch, searchRun } from '../../src/data/schema/provenance.ts'
import { company, normaliseName, posting } from '../../src/data/schema/postings.ts'
import { route } from '../../src/data/schema/registries.ts'
import type { Origin } from '../../src/entities/provenance.ts'
import { firstTouch } from '../../src/provenance/first-touch.ts'
import { rolledBack, type Tx } from './rolled-back.ts'

afterAll(async () => {
  await closeDb()
})

async function addPosting(tx: Tx, token: string, name: string): Promise<number> {
  const [owner] = await tx
    .insert(company)
    .values({ name: `${name} ${token}`, nameNorm: normaliseName(`${name} ${token}`) })
    .returning()
  const [target] = await tx
    .insert(posting)
    .values({
      postingKey: `${name}-${token}`,
      companyId: owner!.id,
      roleTitle: 'Staff Engineer',
      roleNorm: normaliseName('Staff Engineer'),
    })
    .returning()
  return target!.id
}

async function addRoute(tx: Tx, label: string): Promise<number> {
  const [row] = await tx.insert(route).values({ label }).returning()
  return row!.id
}

/** Today's UTC date as the database reads it, the day both the view and the function use. */
async function databaseToday(tx: Tx): Promise<{ text: string; date: Date }> {
  const rows = await tx.execute<{ today: string }>(sql`SELECT (now() AT TIME ZONE 'utc')::date::text AS today`)
  const text = rows[0]!.today
  return { text, date: new Date(`${text}T00:00:00Z`) }
}

/** A calendar day `offset` days from the day given as `YYYY-MM-DD`. */
function dayFrom(text: string, offset: number): string {
  const moved = new Date(`${text}T00:00:00Z`)
  moved.setUTCDate(moved.getUTCDate() + offset)
  return moved.toISOString().slice(0, 10)
}

describe('provenance', () => {
  test('an origin may exist before its posting', async () => {
    // Arrange / Act
    const { before, viewBefore, after, viewAfter } = await rolledBack(async (tx, token) => {
      const routeId = await addRoute(tx, `corridor-${token}`)
      const [floating] = await tx
        .insert(origin)
        .values({ routeId, touchedOn: '2026-01-05', note: 'Dana mentioned an opening' })
        .returning()
      const unattached = await tx.select().from(origin).where(isNull(origin.postingId))
      const viewBeforeRows = await tx.select().from(postingFirstTouch).where(eq(postingFirstTouch.originId, floating!.id))

      const postingId = await addPosting(tx, token, 'later')
      await tx.update(origin).set({ postingId }).where(eq(origin.id, floating!.id))
      const attached = await tx.select().from(origin).where(eq(origin.id, floating!.id))
      const viewAfterRows = await tx.select().from(postingFirstTouch).where(eq(postingFirstTouch.postingId, postingId))
      return {
        before: unattached.filter((row) => row.id === floating!.id),
        viewBefore: viewBeforeRows,
        after: attached[0],
        viewAfter: viewAfterRows,
      }
    })

    // Assert
    expect(before).toHaveLength(1)
    expect(before[0]!.postingId).toBeNull()
    expect(viewBefore).toEqual([])
    expect(after!.postingId).not.toBeNull()
    expect(viewAfter).toHaveLength(1)
    expect(viewAfter[0]!.originId).toBe(after!.id)
  })

  test('one posting carries several origins through the same route on different dates', async () => {
    // Arrange / Act
    const { stored, first } = await rolledBack(async (tx, token) => {
      const routeId = await addRoute(tx, `board-${token}`)
      const postingId = await addPosting(tx, token, 'repost')
      const [run] = await tx.insert(searchRun).values({ query: 'staff engineer', source: 'a board' }).returning()
      await tx.insert(origin).values([
        { postingId, routeId, touchedOn: '2026-02-10', searchRunId: run!.id },
        { postingId, routeId, touchedOn: '2026-03-10', searchRunId: run!.id, note: 'reposted' },
      ])
      return {
        stored: await tx.select().from(origin).where(eq(origin.postingId, postingId)).orderBy(asc(origin.touchedOn)),
        first: await tx.select().from(postingFirstTouch).where(eq(postingFirstTouch.postingId, postingId)),
      }
    })

    // Assert: both rows survive, none merged, and the earlier one is the first touch
    expect(stored.map((row) => row.touchedOn)).toEqual(['2026-02-10', '2026-03-10'])
    expect(stored[0]!.routeId).toBe(stored[1]!.routeId)
    expect(first).toHaveLength(1)
    expect(first[0]!.originId).toBe(stored[0]!.id)
  })

  test('the posting_first_touch view agrees with firstTouch for the fixture', async () => {
    // Arrange / Act
    const outcome = await rolledBack(async (tx, token) => {
      const today = await databaseToday(tx)
      const day = (offset: number) => dayFrom(today.text, offset)
      const at = (hour: number) => new Date(`${day(-1)}T${String(hour).padStart(2, '0')}:00:00Z`)
      const [query, recruiter, friend] = await Promise.all(
        ['query', 'recruiter', 'friend'].map((label) => addRoute(tx, `${label}-${token}`)),
      )

      const backdated = await addPosting(tx, token, 'backdated')
      const tied = await addPosting(tx, token, 'tied')
      const onlyTypo = await addPosting(tx, token, 'typo')
      const onlyToday = await addPosting(tx, token, 'today')
      const typoYear = dayFrom(today.text, 400)

      await tx.insert(origin).values([
        // a query, a recruiter message, a conversation remembered later and backdated, and a typo
        { postingId: backdated, routeId: query!, touchedOn: day(-10), recordedAt: at(10) },
        { postingId: backdated, routeId: recruiter!, touchedOn: day(-8), recordedAt: at(11) },
        { postingId: backdated, routeId: friend!, touchedOn: day(-17), recordedAt: at(12) },
        { postingId: backdated, routeId: query!, touchedOn: typoYear, recordedAt: at(9) },
        // the same day: recorded_at decides, then id for two rows recorded at the same instant
        { postingId: tied, routeId: query!, touchedOn: day(-5), recordedAt: at(14) },
        { postingId: tied, routeId: recruiter!, touchedOn: day(-5), recordedAt: at(8) },
        { postingId: tied, routeId: friend!, touchedOn: day(-5), recordedAt: at(8) },
        // dated after today only: no first touch at all
        { postingId: onlyTypo, routeId: query!, touchedOn: typoYear, recordedAt: at(9) },
        // dated exactly today: counts
        { postingId: onlyToday, routeId: query!, touchedOn: day(0), recordedAt: at(9) },
      ])

      const compared = []
      for (const postingId of [backdated, tied, onlyTypo, onlyToday]) {
        const rows: Origin[] = await tx.select().from(origin).where(eq(origin.postingId, postingId))
        const derived = firstTouch(rows, today.date)
        const [viewRow] = await tx.select().from(postingFirstTouch).where(eq(postingFirstTouch.postingId, postingId))
        compared.push({ postingId, rows, derived, viewRow })
      }
      return { compared, ids: { backdated, tied, onlyTypo, onlyToday }, typoYear }
    })

    // Assert
    for (const { derived, viewRow } of outcome.compared) {
      expect(viewRow?.originId ?? null).toBe(derived?.id ?? null)
      expect(viewRow?.routeId ?? null).toBe(derived?.routeId ?? null)
      expect(viewRow?.touchedOn ?? null).toBe(derived?.touchedOn ?? null)
    }
    const byPosting = new Map(outcome.compared.map((entry) => [entry.postingId, entry]))
    const backdatedEntry = byPosting.get(outcome.ids.backdated)!
    expect(backdatedEntry.derived?.touchedOn).not.toBe(backdatedEntry.rows[0]!.touchedOn)
    expect(backdatedEntry.rows.map((row) => row.touchedOn)).toContain(outcome.typoYear)
    expect(byPosting.get(outcome.ids.tied)!.derived).not.toBeNull()
    expect(byPosting.get(outcome.ids.onlyTypo)!.derived).toBeNull()
    expect(byPosting.get(outcome.ids.onlyTypo)!.viewRow).toBeUndefined()
    expect(byPosting.get(outcome.ids.onlyToday)!.derived).not.toBeNull()
    expect(byPosting.get(outcome.ids.onlyToday)!.viewRow).toBeDefined()
  })

  test('the view and firstTouch agree whatever time zone the session uses', async () => {
    // Arrange: one zone far ahead of UTC and one far behind. Between them, at every hour of the
    // day at least one has a local date that differs from the UTC date, which is what a view
    // built on the session's CURRENT_DATE would get wrong.
    const farZones = ['Pacific/Kiritimati', 'Etc/GMT+12']

    // Act
    const runs = []
    for (const zone of farZones) {
      runs.push(
        await rolledBack(async (tx, token) => {
          await tx.execute(sql.raw(`SET LOCAL TimeZone = '${zone}'`))
          const utcToday = await databaseToday(tx)
          const localToday = await tx.execute<{ today: string }>(sql`SELECT CURRENT_DATE::text AS today`)
          const routeId = await addRoute(tx, `zone-${token}`)
          const tomorrowOnly = await addPosting(tx, token, 'tomorrow')
          const todayOnly = await addPosting(tx, token, 'today')
          const mixed = await addPosting(tx, token, 'mixed')
          const tomorrow = dayFrom(utcToday.text, 1)
          await tx.insert(origin).values([
            { postingId: tomorrowOnly, routeId, touchedOn: tomorrow },
            { postingId: todayOnly, routeId, touchedOn: utcToday.text },
            { postingId: mixed, routeId, touchedOn: tomorrow },
            { postingId: mixed, routeId, touchedOn: utcToday.text },
          ])
          const compared = []
          for (const postingId of [tomorrowOnly, todayOnly, mixed]) {
            const rows: Origin[] = await tx.select().from(origin).where(eq(origin.postingId, postingId))
            const [viewRow] = await tx.select().from(postingFirstTouch).where(eq(postingFirstTouch.postingId, postingId))
            compared.push({ derived: firstTouch(rows, utcToday.date), viewRow })
          }
          return { zone, localDiffers: localToday[0]!.today !== utcToday.text, compared }
        }),
      )
    }

    // Assert: the zone really moved the date for at least one run, and the two sides still agree
    expect(runs.some((run) => run.localDiffers)).toBe(true)
    for (const run of runs) {
      for (const { derived, viewRow } of run.compared) {
        expect(viewRow?.originId ?? null).toBe(derived?.id ?? null)
        expect(viewRow?.touchedOn ?? null).toBe(derived?.touchedOn ?? null)
      }
      expect(run.compared[0]!.derived).toBeNull()
      expect(run.compared[1]!.derived).not.toBeNull()
      expect(run.compared[2]!.derived?.touchedOn).toBe(run.compared[1]!.derived?.touchedOn)
    }
  })

  test('an archived route still resolves its label from an origin, and leaves the pick-list', async () => {
    // Arrange / Act
    const { resolved, pickList } = await rolledBack(async (tx, token) => {
      const [kept] = await tx.insert(route).values({ label: `kept-${token}` }).returning()
      const [retired] = await tx.insert(route).values({ label: `retired-${token}` }).returning()
      await tx.insert(origin).values({ routeId: retired!.id, touchedOn: '2026-01-05' })
      await tx.update(route).set({ archivedAt: new Date() }).where(eq(route.id, retired!.id))
      return {
        resolved: await tx
          .select({ label: route.label, archivedAt: route.archivedAt })
          .from(origin)
          .innerJoin(route, eq(origin.routeId, route.id))
          .where(eq(origin.routeId, retired!.id)),
        pickList: (await tx.select().from(route).where(isNull(route.archivedAt))).map((row) => row.id).filter(
          (id) => id === kept!.id || id === retired!.id,
        ),
      }
    })

    // Assert
    expect(resolved).toHaveLength(1)
    expect(resolved[0]!.label.startsWith('retired-')).toBe(true)
    expect(resolved[0]!.archivedAt).not.toBeNull()
    expect(pickList).toHaveLength(1)
  })
})
