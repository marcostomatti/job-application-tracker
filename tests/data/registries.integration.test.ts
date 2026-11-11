import { afterAll, describe, expect, test } from 'bun:test'
import { count, eq, isNull, sql } from 'drizzle-orm'

import { closeDb, getDb } from '../../src/data/client.ts'
import {
  applyRoute,
  artefactKind,
  layer,
  penaltyKind,
  phase,
  rejectionReason,
  route,
  seniority,
  setAsideReason,
  stage,
  textType,
  workFormat,
} from '../../src/data/schema/registries.ts'
import { withMigratedScratchDatabase } from './scratch-database.ts'

const REGISTRY_TABLE_NAMES = [
  'phase',
  'stage',
  'layer',
  'route',
  'set_aside_reason',
  'rejection_reason',
  'penalty_kind',
  'text_type',
  'artefact_kind',
  'work_format',
  'seniority',
  'apply_route',
]

const ALL_REGISTRIES = [
  phase,
  stage,
  layer,
  route,
  setAsideReason,
  rejectionReason,
  penaltyKind,
  textType,
  artefactKind,
  workFormat,
  seniority,
  applyRoute,
]

class Rollback extends Error {}

/**
 * Runs `body` inside a transaction that is always rolled back, so a test can
 * insert rows without leaving any behind for the "every registry is empty" test.
 */
async function rolledBack<T>(
  body: (tx: Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0]) => Promise<T>,
): Promise<T> {
  let result: T | undefined
  try {
    await getDb().transaction(async (tx) => {
      result = await body(tx)
      throw new Rollback()
    })
  } catch (error) {
    if (!(error instanceof Rollback)) throw error
  }
  return result as T
}

afterAll(async () => {
  await closeDb()
})

describe('registries', () => {
  test('every registry is empty after migrating', async () => {
    // Arrange / Act: migrate into a database nothing else has touched. The shared dev database
    // proves nothing about the migrations, since a user may have loaded a pack into it.
    const { counts, discovered } = await withMigratedScratchDatabase(async (db, raw) => {
      const found = await raw<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name IN ('label', 'archived_at')
        GROUP BY table_name HAVING count(*) = 2
      `
      return {
        counts: await Promise.all(
          ALL_REGISTRIES.map((table) => db.select({ n: count() }).from(table).then((rows) => rows[0]?.n)),
        ),
        discovered: found.map((row) => row.table_name).sort(),
      }
    })

    // Assert: twelve registries, found in the database as well as listed here, so a thirteenth
    // added later fails this test until it is accounted for
    expect(ALL_REGISTRIES).toHaveLength(12)
    expect(discovered).toEqual([...REGISTRY_TABLE_NAMES].sort())
    expect(counts).toEqual(ALL_REGISTRIES.map(() => 0))
  })

  test('a phase carries is_shortlist and a stage carries is_applied', async () => {
    // Arrange / Act
    const { flagged, unflagged } = await rolledBack(async (tx) => {
      const [shortlistPhase] = await tx
        .insert(phase)
        .values({ key: 'p1', label: 'Phase one', isShortlist: true })
        .returning()
      const [plainPhase] = await tx.insert(phase).values({ key: 'p2', label: 'Phase two' }).returning()
      const [appliedStage] = await tx
        .insert(stage)
        .values({ key: 's1', label: 'Stage one', isApplied: true })
        .returning()
      const [plainStage] = await tx.insert(stage).values({ key: 's2', label: 'Stage two' }).returning()
      return {
        flagged: { phase: shortlistPhase, stage: appliedStage },
        unflagged: { phase: plainPhase, stage: plainStage },
      }
    })

    // Assert: the user sets the flag, and it defaults to off so the template assumes nothing
    expect(flagged.phase?.isShortlist).toBe(true)
    expect(flagged.stage?.isApplied).toBe(true)
    expect(unflagged.phase?.isShortlist).toBe(false)
    expect(unflagged.stage?.isApplied).toBe(false)
  })

  test('an archived row is still readable by id and absent from a pick-list query', async () => {
    // Arrange / Act
    const { keptId, retiredId, byId, pickList } = await rolledBack(async (tx) => {
      const [kept] = await tx.insert(route).values({ label: 'Kept row' }).returning({ id: route.id })
      const [retired] = await tx.insert(route).values({ label: 'Retired row' }).returning({ id: route.id })
      const retiredId = retired?.id as number
      await tx.update(route).set({ archivedAt: sql`now()` }).where(eq(route.id, retiredId))
      return {
        keptId: kept?.id,
        retiredId,
        byId: await tx.select().from(route).where(eq(route.id, retiredId)),
        pickList: await tx.select().from(route).where(isNull(route.archivedAt)),
      }
    })

    // Assert: a reference to the archived row can still show its label; a new pick cannot choose it
    expect(byId[0]?.label).toBe('Retired row')
    expect(byId[0]?.archivedAt).not.toBeNull()
    expect(pickList.map((row) => row.id)).toEqual([keptId as number])
    expect(pickList.map((row) => row.id)).not.toContain(retiredId)
  })

  test('a registry column is nullable wherever another table references it', async () => {
    // Arrange
    const db = getDb()

    // Act
    const references = await db.execute<{ owner: string; column: string; nullable: boolean; target: string }>(sql`
      select c.conrelid::regclass::text as owner,
             a.attname::text as "column",
             not a.attnotnull as nullable,
             c.confrelid::regclass::text as target
      from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
      where c.contype = 'f' and c.connamespace = 'public'::regnamespace
    `)
    const toRegistries = references.filter((row) => REGISTRY_TABLE_NAMES.includes(row.target))

    // Assert: stage.phase_id is the one reference at this point; guard against a vacuous pass
    expect(toRegistries.some((row) => row.owner === 'stage' && row.column === 'phase_id')).toBe(true)
    // The one deliberate exception: a penalty row is an application of a penalty kind, so with
    // an empty registry the right state is no penalty rows, not penalty rows without a kind.
    // The exception is listed by name, so any other NOT NULL registry reference still fails.
    const notNull = toRegistries.filter((row) => !row.nullable).map((row) => `${row.owner}.${row.column}`)
    expect(notNull).toEqual(['posting_penalty.penalty_kind_id'])
  })
})
