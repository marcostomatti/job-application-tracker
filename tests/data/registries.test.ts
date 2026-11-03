import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { count, eq, isNull, sql } from 'drizzle-orm'

import { lintMigrations } from '../../drizzle/lint/migration-lint'
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

const MIGRATIONS_DIR = join(import.meta.dir, '..', '..', 'drizzle')
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
    // Arrange
    const db = getDb()

    // Act
    const counts = await Promise.all(
      ALL_REGISTRIES.map((table) => db.select({ n: count() }).from(table).then((rows) => rows[0]?.n)),
    )

    // Assert
    expect(ALL_REGISTRIES).toHaveLength(12)
    expect(counts).toEqual(ALL_REGISTRIES.map(() => 0))
  })

  test('the migration passes the lint', () => {
    // Arrange
    const migration = join(MIGRATIONS_DIR, '0000_registries.sql')

    // Act
    const findings = lintMigrations(MIGRATIONS_DIR).filter((finding) => finding.file === migration)

    // Assert: the file must exist, or "no findings" would pass for the wrong reason
    expect(existsSync(migration)).toBe(true)
    expect(findings).toEqual([])
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
    expect(toRegistries.filter((row) => !row.nullable)).toEqual([])
  })
})
