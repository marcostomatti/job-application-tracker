import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { asc, eq, isNull, sql } from 'drizzle-orm'

import { lintMigrations } from '../../drizzle/lint/migration-lint'
import { closeDb } from '../../src/data/client.ts'
import { origin, positionFirstTouch, searchRun } from '../../src/data/schema/provenance.ts'
import { company, normaliseName, position } from '../../src/data/schema/positions.ts'
import { route } from '../../src/data/schema/registries.ts'
import type { Origin } from '../../src/entities/provenance.ts'
import { firstTouch } from '../../src/provenance/first-touch.ts'
import { rolledBack, type Tx } from './rolled-back.ts'

const MIGRATIONS_DIR = join(import.meta.dir, '..', '..', 'drizzle')

afterAll(async () => {
  await closeDb()
})

async function addPosition(tx: Tx, token: string, name: string): Promise<number> {
  const [owner] = await tx
    .insert(company)
    .values({ name: `${name} ${token}`, nameNorm: normaliseName(`${name} ${token}`) })
    .returning()
  const [target] = await tx
    .insert(position)
    .values({
      positionKey: `${name}-${token}`,
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

/** The database's own idea of today, so the view and the function are asked about the same day. */
async function databaseToday(tx: Tx): Promise<{ text: string; date: Date }> {
  const rows = await tx.execute<{ today: string }>(sql`SELECT CURRENT_DATE::text AS today`)
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
  test('an origin may exist before its position', async () => {
    // Arrange / Act
    const { before, viewBefore, after, viewAfter } = await rolledBack(async (tx, token) => {
      const routeId = await addRoute(tx, `corridor-${token}`)
      const [floating] = await tx
        .insert(origin)
        .values({ routeId, touchedOn: '2026-01-05', note: 'Dana mentioned an opening' })
        .returning()
      const unattached = await tx.select().from(origin).where(isNull(origin.positionId))
      const viewBeforeRows = await tx.select().from(positionFirstTouch).where(eq(positionFirstTouch.originId, floating!.id))

      const positionId = await addPosition(tx, token, 'later')
      await tx.update(origin).set({ positionId }).where(eq(origin.id, floating!.id))
      const attached = await tx.select().from(origin).where(eq(origin.id, floating!.id))
      const viewAfterRows = await tx.select().from(positionFirstTouch).where(eq(positionFirstTouch.positionId, positionId))
      return {
        before: unattached.filter((row) => row.id === floating!.id),
        viewBefore: viewBeforeRows,
        after: attached[0],
        viewAfter: viewAfterRows,
      }
    })

    // Assert
    expect(before).toHaveLength(1)
    expect(before[0]!.positionId).toBeNull()
    expect(viewBefore).toEqual([])
    expect(after!.positionId).not.toBeNull()
    expect(viewAfter).toHaveLength(1)
    expect(viewAfter[0]!.originId).toBe(after!.id)
  })

  test('one position carries several origins through the same route on different dates', async () => {
    // Arrange / Act
    const { stored, first } = await rolledBack(async (tx, token) => {
      const routeId = await addRoute(tx, `board-${token}`)
      const positionId = await addPosition(tx, token, 'repost')
      const [run] = await tx.insert(searchRun).values({ query: 'staff engineer', source: 'a board' }).returning()
      await tx.insert(origin).values([
        { positionId, routeId, touchedOn: '2026-02-10', searchRunId: run!.id },
        { positionId, routeId, touchedOn: '2026-03-10', searchRunId: run!.id, note: 'reposted' },
      ])
      return {
        stored: await tx.select().from(origin).where(eq(origin.positionId, positionId)).orderBy(asc(origin.touchedOn)),
        first: await tx.select().from(positionFirstTouch).where(eq(positionFirstTouch.positionId, positionId)),
      }
    })

    // Assert: both rows survive, none merged, and the earlier one is the first touch
    expect(stored.map((row) => row.touchedOn)).toEqual(['2026-02-10', '2026-03-10'])
    expect(stored[0]!.routeId).toBe(stored[1]!.routeId)
    expect(first).toHaveLength(1)
    expect(first[0]!.originId).toBe(stored[0]!.id)
  })

  test('the position_first_touch view agrees with firstTouch for the fixture', async () => {
    // Arrange / Act
    const outcome = await rolledBack(async (tx, token) => {
      const today = await databaseToday(tx)
      const day = (offset: number) => dayFrom(today.text, offset)
      const at = (hour: number) => new Date(`${day(-1)}T${String(hour).padStart(2, '0')}:00:00Z`)
      const [query, recruiter, friend] = await Promise.all(
        ['query', 'recruiter', 'friend'].map((label) => addRoute(tx, `${label}-${token}`)),
      )

      const backdated = await addPosition(tx, token, 'backdated')
      const tied = await addPosition(tx, token, 'tied')
      const onlyTypo = await addPosition(tx, token, 'typo')
      const onlyToday = await addPosition(tx, token, 'today')
      const typoYear = dayFrom(today.text, 400)

      await tx.insert(origin).values([
        // a query, a recruiter message, a conversation remembered later and backdated, and a typo
        { positionId: backdated, routeId: query!, touchedOn: day(-10), recordedAt: at(10) },
        { positionId: backdated, routeId: recruiter!, touchedOn: day(-8), recordedAt: at(11) },
        { positionId: backdated, routeId: friend!, touchedOn: day(-17), recordedAt: at(12) },
        { positionId: backdated, routeId: query!, touchedOn: typoYear, recordedAt: at(9) },
        // the same day: recorded_at decides, then id for two rows recorded at the same instant
        { positionId: tied, routeId: query!, touchedOn: day(-5), recordedAt: at(14) },
        { positionId: tied, routeId: recruiter!, touchedOn: day(-5), recordedAt: at(8) },
        { positionId: tied, routeId: friend!, touchedOn: day(-5), recordedAt: at(8) },
        // dated after today only: no first touch at all
        { positionId: onlyTypo, routeId: query!, touchedOn: typoYear, recordedAt: at(9) },
        // dated exactly today: counts
        { positionId: onlyToday, routeId: query!, touchedOn: day(0), recordedAt: at(9) },
      ])

      const compared = []
      for (const positionId of [backdated, tied, onlyTypo, onlyToday]) {
        const rows: Origin[] = await tx.select().from(origin).where(eq(origin.positionId, positionId))
        const derived = firstTouch(rows, today.date)
        const [viewRow] = await tx.select().from(positionFirstTouch).where(eq(positionFirstTouch.positionId, positionId))
        compared.push({ positionId, rows, derived, viewRow })
      }
      return { compared, ids: { backdated, tied, onlyTypo, onlyToday }, typoYear }
    })

    // Assert
    for (const { derived, viewRow } of outcome.compared) {
      expect(viewRow?.originId ?? null).toBe(derived?.id ?? null)
      expect(viewRow?.routeId ?? null).toBe(derived?.routeId ?? null)
      expect(viewRow?.touchedOn ?? null).toBe(derived?.touchedOn ?? null)
    }
    const byPosition = new Map(outcome.compared.map((entry) => [entry.positionId, entry]))
    const backdatedEntry = byPosition.get(outcome.ids.backdated)!
    expect(backdatedEntry.derived?.touchedOn).not.toBe(backdatedEntry.rows[0]!.touchedOn)
    expect(backdatedEntry.rows.map((row) => row.touchedOn)).toContain(outcome.typoYear)
    expect(byPosition.get(outcome.ids.tied)!.derived).not.toBeNull()
    expect(byPosition.get(outcome.ids.onlyTypo)!.derived).toBeNull()
    expect(byPosition.get(outcome.ids.onlyTypo)!.viewRow).toBeUndefined()
    expect(byPosition.get(outcome.ids.onlyToday)!.derived).not.toBeNull()
    expect(byPosition.get(outcome.ids.onlyToday)!.viewRow).toBeDefined()
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

  test('the migration passes the lint', () => {
    // Arrange
    const migration = join(MIGRATIONS_DIR, '0005_provenance.sql')

    // Act
    const findings = lintMigrations(MIGRATIONS_DIR).filter((finding) => finding.file === migration)

    // Assert: the file must exist, or "no findings" would pass for the wrong reason
    expect(existsSync(migration)).toBe(true)
    expect(findings).toEqual([])
  })
})
