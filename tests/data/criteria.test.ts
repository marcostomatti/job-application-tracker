import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { and, eq, isNull } from 'drizzle-orm'

import { lintMigrations } from '../../drizzle/lint/migration-lint'
import { closeDb, getDb } from '../../src/data/client.ts'
import { CriteriaSetConflictError, criteriaSet, detour, insertCriteriaSet, requirement } from '../../src/data/schema/criteria.ts'

const MIGRATIONS_DIR = join(import.meta.dir, '..', '..', 'drizzle')
const ANCHORS = { '0': 'does not meet it', '0.5': 'partly meets it', '1': 'fully meets it' }

type Tx = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0]

class Rollback extends Error {}

/**
 * Runs `body` in a transaction that is always rolled back, so these tests
 * leave no rows behind and stay true on a database other tasks have touched.
 * Every set name is unique per call for the same reason.
 */
async function rolledBack<T>(body: (tx: Tx, name: string) => Promise<T>): Promise<T> {
  let result: T | undefined
  const name = `test-set-${crypto.randomUUID()}`
  try {
    await getDb().transaction(async (tx) => {
      result = await body(tx, name)
      throw new Rollback()
    })
  } catch (error) {
    if (!(error instanceof Rollback)) throw error
  }
  return result as T
}

/** Runs `attempt` and returns what it threw, or undefined when it did not throw. */
async function thrownBy(attempt: () => Promise<unknown>): Promise<unknown> {
  try {
    await attempt()
  } catch (error) {
    return error
  }
  return undefined
}

/**
 * Runs `run` in a savepoint and returns what it threw. A failed statement aborts the
 * enclosing transaction, so a test that expects several failures needs one savepoint each.
 */
function thrownInSavepoint(tx: Tx, run: (inner: Tx) => Promise<unknown>): Promise<unknown> {
  return thrownBy(() => tx.transaction((inner) => run(inner as Tx)))
}

/**
 * The driver's own message, which names the violated constraint or column. Drizzle wraps
 * the driver error as `cause`; its own message repeats the whole query, which would make
 * every column name match, so only the cause is read.
 */
function violationText(error: unknown): string {
  const cause = error instanceof Error ? (error.cause as { message?: string } | undefined) : undefined
  return cause?.message ?? ''
}

afterAll(async () => {
  await closeDb()
})

describe('criteria sets, requirements and detours', () => {
  test('a criteria set accepts a null apply_threshold', async () => {
    // Arrange / Act
    const row = await rolledBack(async (tx, name) => {
      const [created] = await tx.insert(criteriaSet).values({ name, version: 1 }).returning()
      return created
    })

    // Assert: a vanilla pack ships without a bar; it is not the default until someone says so
    expect(row?.applyThreshold).toBeNull()
    expect(row?.isDefault).toBe(false)
    expect(row?.archivedAt).toBeNull()
  })

  test('a requirement accepts a null weight', async () => {
    // Arrange / Act
    const row = await rolledBack(async (tx, name) => {
      const [set] = await tx.insert(criteriaSet).values({ name, version: 1 }).returning()
      const [created] = await tx
        .insert(requirement)
        .values({ criteriaSetId: set?.id as number, key: 'r1', label: 'R1', anchors: ANCHORS })
        .returning()
      return created
    })

    // Assert: weight is the user's judgement, so a pack can leave it unset; layer is unset too
    expect(row?.weight).toBeNull()
    expect(row?.layerId).toBeNull()
    expect(row?.kind).toBe('soft')
  })

  test('a requirement requires anchors', async () => {
    // Arrange / Act
    const error = await rolledBack(async (tx, name) => {
      const [set] = await tx.insert(criteriaSet).values({ name, version: 1 }).returning()
      return thrownBy(() =>
        tx
          .insert(requirement)
          // The type forbids the omission, which is the point; the cast reaches the database check
          .values({ criteriaSetId: set?.id as number, key: 'r1', label: 'R1' } as never),
      )
    })

    // Assert: anchors is what makes a weight meaningful to someone else
    expect(error).toBeInstanceOf(Error)
    expect(violationText(error)).toContain('anchors')
  })

  test('requirement keys are unique within a set but not across sets', async () => {
    // Arrange / Act
    const { acrossSets, withinSet } = await rolledBack(async (tx, name) => {
      const [first] = await tx.insert(criteriaSet).values({ name, version: 1 }).returning()
      const [second] = await tx.insert(criteriaSet).values({ name, version: 2 }).returning()
      const base = { key: 'shared', label: 'Shared', anchors: ANCHORS }
      await tx.insert(requirement).values({ ...base, criteriaSetId: first?.id as number })
      const acrossSets = await thrownBy(() =>
        tx.insert(requirement).values({ ...base, criteriaSetId: second?.id as number }),
      )
      const withinSet = await thrownBy(() =>
        tx.insert(requirement).values({ ...base, criteriaSetId: first?.id as number }),
      )
      return { acrossSets, withinSet }
    })

    // Assert
    expect(acrossSets).toBeUndefined()
    expect(violationText(withinSet)).toContain('requirement_criteria_set_id_key_unique')
  })

  test('inserting a duplicate name and version raises a distinguishable conflict', async () => {
    // Arrange / Act
    const { first, error } = await rolledBack(async (tx, name) => {
      const first = await insertCriteriaSet(tx, { name, version: 1 })
      const error = await thrownBy(() => insertCriteriaSet(tx, { name, version: 1 }))
      return { first, error }
    })

    // Assert: a retried bulk insert can treat this class as a no-op, a real failure it cannot
    expect(first.version).toBe(1)
    expect(error).toBeInstanceOf(CriteriaSetConflictError)
    expect((error as CriteriaSetConflictError).setName).toContain('test-set-')
    expect((error as CriteriaSetConflictError).version).toBe(1)
  })

  test('a failure that is not a name and version conflict is not reported as one', async () => {
    // Arrange / Act
    const error = await rolledBack((tx, name) => thrownBy(() => insertCriteriaSet(tx, { name, version: 1, applyThreshold: '1.5' })))

    // Assert: the range check is a different failure and must stay a different failure
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(CriteriaSetConflictError)
    expect(violationText(error)).toContain('criteria_set_apply_threshold_check')
  })

  test('the kind column accepts only gate or soft', async () => {
    // Arrange / Act
    const { gate, soft, other } = await rolledBack(async (tx, name) => {
      const [set] = await tx.insert(criteriaSet).values({ name, version: 1 }).returning()
      const base = { criteriaSetId: set?.id as number, label: 'L', anchors: ANCHORS }
      const [gate] = await tx.insert(requirement).values({ ...base, key: 'g', kind: 'gate' }).returning()
      const [soft] = await tx.insert(requirement).values({ ...base, key: 's', kind: 'soft' }).returning()
      const other = await thrownBy(() =>
        tx.insert(requirement).values({ ...base, key: 'o', kind: 'optional' as never }),
      )
      return { gate, soft, other }
    })

    // Assert
    expect(gate?.kind).toBe('gate')
    expect(soft?.kind).toBe('soft')
    expect(violationText(other)).toContain('requirement_kind_check')
  })

  test('apply_threshold is bounded to 0 through 1 and weight to 0 or more', async () => {
    // Arrange / Act
    const outcome = await rolledBack(async (tx, name) => {
      const insertSet = (version: number, applyThreshold: string) =>
        thrownInSavepoint(tx, (inner) => inner.insert(criteriaSet).values({ name, version, applyThreshold }))
      const [set] = await tx.insert(criteriaSet).values({ name, version: 100 }).returning()
      const insertWeight = (key: string, weight: string) =>
        thrownInSavepoint(tx, (inner) =>
          inner.insert(requirement).values({ criteriaSetId: set?.id as number, key, label: key, anchors: ANCHORS, weight }),
        )
      return {
        tooHigh: await insertSet(1, '1.5'),
        negative: await insertSet(2, '-0.1'),
        zeroBar: await insertSet(3, '0'),
        oneBar: await insertSet(4, '1'),
        negativeWeight: await insertWeight('n', '-1'),
        zeroWeight: await insertWeight('z', '0'),
      }
    })

    // Assert: a threshold of 1.5 would stop anything being recommended; a negative weight is ignored by the overall but still ranked by the limiter
    expect(violationText(outcome.tooHigh)).toContain('criteria_set_apply_threshold_check')
    expect(violationText(outcome.negative)).toContain('criteria_set_apply_threshold_check')
    expect(outcome.zeroBar).toBeUndefined()
    expect(outcome.oneBar).toBeUndefined()
    expect(violationText(outcome.negativeWeight)).toContain('requirement_weight_check')
    expect(outcome.zeroWeight).toBeUndefined()
  })

  test('a detour discount is bounded to 0 through 1 and cost is optional', async () => {
    // Arrange / Act
    const outcome = await rolledBack(async (tx, name) => {
      const [set] = await tx.insert(criteriaSet).values({ name, version: 1 }).returning()
      const [req] = await tx
        .insert(requirement)
        .values({ criteriaSetId: set?.id as number, key: 'r', label: 'R', anchors: ANCHORS })
        .returning()
      const requirementId = req?.id as number
      const [ok] = await tx.insert(detour).values({ requirementId, label: 'Way round', discount: '0.5' }).returning()
      const tooHigh = await thrownInSavepoint(tx, (inner) => inner.insert(detour).values({ requirementId, label: 'x', discount: '1.5' }))
      const negative = await thrownInSavepoint(tx, (inner) => inner.insert(detour).values({ requirementId, label: 'y', discount: '-0.5' }))
      const missing = await thrownInSavepoint(tx, (inner) => inner.insert(detour).values({ requirementId, label: 'z' } as never))
      return { ok, tooHigh, negative, missing }
    })

    // Assert
    expect(outcome.ok?.costAmount).toBeNull()
    expect(outcome.ok?.costUnit).toBeNull()
    expect(violationText(outcome.tooHigh)).toContain('detour_discount_check')
    expect(violationText(outcome.negative)).toContain('detour_discount_check')
    expect(violationText(outcome.missing)).toContain('discount')
  })

  test('deleting a set removes its requirements, and a requirement its detours', async () => {
    // Arrange / Act
    const left = await rolledBack(async (tx, name) => {
      const [set] = await tx.insert(criteriaSet).values({ name, version: 1 }).returning()
      const [req] = await tx
        .insert(requirement)
        .values({ criteriaSetId: set?.id as number, key: 'r', label: 'R', anchors: ANCHORS })
        .returning()
      await tx.insert(detour).values({ requirementId: req?.id as number, label: 'D', discount: '0.2' })
      await tx.delete(criteriaSet).where(eq(criteriaSet.id, set?.id as number))
      return {
        requirements: await tx.select().from(requirement).where(eq(requirement.id, req?.id as number)),
        detours: await tx.select().from(detour).where(eq(detour.requirementId, req?.id as number)),
      }
    })

    // Assert: scoped to rows this test created
    expect(left.requirements).toEqual([])
    expect(left.detours).toEqual([])
  })

  test('the migration passes the lint', () => {
    // Arrange
    const migration = join(MIGRATIONS_DIR, '0001_criteria.sql')

    // Act
    const findings = lintMigrations(MIGRATIONS_DIR).filter((finding) => finding.file === migration)

    // Assert: the file must exist, or "no findings" would pass for the wrong reason
    expect(existsSync(migration)).toBe(true)
    expect(findings).toEqual([])
  })
})

describe('the default criteria set', () => {
  test('at most one active criteria set can be the default', async () => {
    // Arrange / Act
    const { second, plain, archivedPair } = await rolledBack(async (tx, name) => {
      // Clear any committed active default first, inside this rolled-back transaction, so the
      // test does not depend on what other tasks' data holds
      await tx
        .update(criteriaSet)
        .set({ archivedAt: new Date() })
        .where(and(eq(criteriaSet.isDefault, true), isNull(criteriaSet.archivedAt)))
      await tx.insert(criteriaSet).values({ name, version: 1, isDefault: true })
      const second = await thrownInSavepoint(tx, (inner) =>
        inner.insert(criteriaSet).values({ name, version: 2, isDefault: true }),
      )
      // A non-default set is unaffected, and an archived default frees the slot
      const plain = await thrownInSavepoint(tx, (inner) =>
        inner.insert(criteriaSet).values({ name, version: 3, isDefault: false }),
      )
      const archivedPair = await thrownInSavepoint(tx, (inner) =>
        inner.insert(criteriaSet).values({ name, version: 4, isDefault: true, archivedAt: new Date() }),
      )
      return { second, plain, archivedPair }
    })

    // Assert: a second active default is an error, not a silent pick
    expect(violationText(second)).toContain('criteria_set_single_default')
    expect(plain).toBeUndefined()
    expect(archivedPair).toBeUndefined()
  })
})
