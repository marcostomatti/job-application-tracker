import { describe, expect, test } from 'bun:test'
import { count, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import type { DrizzleClient } from '../../src/data/client.ts'
import {
  createCriteriaVersion,
  getRequirements,
  listCriteriaSets,
  setDefaultCriteriaSet,
  updateRequirement,
} from '../../src/data/repositories/criteria.ts'
import { CriteriaSetConflictError, criteriaSet, detour, insertCriteriaSet, requirement } from '../../src/data/schema/criteria.ts'
import { layer } from '../../src/data/schema/registries.ts'
import { ArchivedError, ConflictError, NotFoundError, statusFor } from '../../src/errors.ts'
import {
  CriteriaSetQuerySchema,
  CriteriaVersionInputSchema,
  RequirementPatchSchema,
} from '../../src/schemas/criteria.ts'
import { thrownBy } from '../data/rolled-back.ts'
import { withMigratedScratchDatabase } from '../data/scratch-database.ts'

const ANCHORS = { '0': 'nothing', '0.5': 'some', '1': 'everything' }

/** The id at `index`, or a loud failure: an absent row would otherwise read as a pass. */
function idOf(rows: readonly { readonly id: number }[], index = 0): number {
  const id = rows[index]?.id
  if (id === undefined) throw new Error(`the arrangement produced no row at index ${index}`)
  return id
}

/**
 * A set the user has judged: a threshold, two weighted requirements (one a gate with a null
 * weight), one of them in a layer and carrying two detours, one of those priced.
 */
async function judgedSet(db: DrizzleClient, name = 'Mine'): Promise<{ setId: number; layerId: number }> {
  const layerId = idOf(await db.insert(layer).values({ key: `l-${name}`, label: `Layer of ${name}` }).returning())
  const set = await insertCriteriaSet(db, { name, version: 1, applyThreshold: 0.6 })
  const [first, second] = await db
    .insert(requirement)
    .values([
      { criteriaSetId: set.id, layerId, key: 'a', label: 'First', kind: 'soft', weight: 2.5, anchors: ANCHORS, sort: 1 },
      { criteriaSetId: set.id, key: 'b', label: 'Second', kind: 'gate', weight: null, anchors: ANCHORS, sort: 0 },
    ])
    .returning()
  if (!first || !second) throw new Error('the arrangement stored no requirements')
  await db.insert(detour).values([
    { requirementId: first.id, label: 'Way round', discount: 0.25, costAmount: '120.50', costUnit: 'units' },
    { requirementId: first.id, label: 'Other way', discount: 0.5 },
  ])
  return { setId: set.id, layerId }
}

describe('listCriteriaSets', () => {
  test('lists newest first and hides archived sets unless asked', async () => {
    // Arrange / Act
    const { visible, all } = await withMigratedScratchDatabase(async (db) => {
      const older = await insertCriteriaSet(db, { name: 'Older', createdAt: new Date('2026-01-01') })
      await insertCriteriaSet(db, { name: 'Newer', createdAt: new Date('2026-03-01') })
      await insertCriteriaSet(db, { name: 'Gone', createdAt: new Date('2026-02-01'), archivedAt: new Date() })
      expect(older.id).toBeGreaterThan(0)
      return { visible: await listCriteriaSets(db), all: await listCriteriaSets(db, { includeArchived: true }) }
    })

    // Assert
    expect(visible.map((row) => row.name)).toEqual(['Newer', 'Older'])
    expect(all.map((row) => row.name)).toEqual(['Newer', 'Gone', 'Older'])
  })

  test('returns the version, threshold and default flag, with null where no bar is set', async () => {
    // Arrange / Act
    const rows = await withMigratedScratchDatabase(async (db) => {
      await insertCriteriaSet(db, { name: 'Bare' })
      await insertCriteriaSet(db, { name: 'Judged', applyThreshold: 0.7, isDefault: true })
      return listCriteriaSets(db)
    })

    // Assert
    const bare = rows.find((row) => row.name === 'Bare')
    const judged = rows.find((row) => row.name === 'Judged')
    expect(bare).toMatchObject({ version: 1, applyThreshold: null, isDefault: false })
    expect(judged).toMatchObject({ applyThreshold: 0.7, isDefault: true })
    expect(judged?.createdAt).toBeInstanceOf(Date)
  })
})

describe('getRequirements', () => {
  test('returns requirements in sort order with the layer label and the detours', async () => {
    // Arrange / Act
    const rows = await withMigratedScratchDatabase(async (db) => {
      const { setId } = await judgedSet(db)
      return getRequirements(db, setId)
    })

    // Assert
    expect(rows.map((row) => row.key)).toEqual(['b', 'a'])
    const [gate, soft] = rows
    expect(gate).toMatchObject({ layerId: null, layerLabel: null, detours: [], weight: null, kind: 'gate' })
    expect(soft).toMatchObject({ layerLabel: 'Layer of Mine', weight: 2.5, anchors: ANCHORS })
    expect(soft?.detours.map((entry) => [entry.label, entry.discount, entry.costAmount, entry.costUnit])).toEqual([
      ['Way round', 0.25, '120.50', 'units'],
      ['Other way', 0.5, null, null],
    ])
  })

  test('still renders the label of a layer archived after the requirement was stored', async () => {
    // Arrange / Act
    const rows = await withMigratedScratchDatabase(async (db) => {
      const { setId, layerId } = await judgedSet(db)
      await db.update(layer).set({ archivedAt: new Date() }).where(eq(layer.id, layerId))
      return getRequirements(db, setId)
    })

    // Assert
    expect(rows.find((row) => row.key === 'a')?.layerLabel).toBe('Layer of Mine')
  })

  test('returns an empty list for a set with no requirements and refuses a set that does not exist', async () => {
    // Arrange / Act
    const { empty, missing } = await withMigratedScratchDatabase(async (db) => {
      const set = await insertCriteriaSet(db, { name: 'Empty' })
      return { empty: await getRequirements(db, set.id), missing: await thrownBy(() => getRequirements(db, 9999)) }
    })

    // Assert
    expect(empty).toEqual([])
    expect(missing).toBeInstanceOf(NotFoundError)
  })
})

describe('createCriteriaVersion', () => {
  test('copies requirements, anchors, detours, weights and the threshold', async () => {
    // Arrange / Act
    const { created, copied, source } = await withMigratedScratchDatabase(async (db) => {
      const { setId } = await judgedSet(db)
      const created = await createCriteriaVersion(db, { fromSetId: setId })
      return { created, copied: await getRequirements(db, created.id), source: await getRequirements(db, setId) }
    })

    // Assert
    expect(created).toMatchObject({ name: 'Mine', version: 2, applyThreshold: 0.6 })
    const strip = (rows: typeof copied) =>
      rows.map(({ id, criteriaSetId, detours, ...rest }) => ({
        ...rest,
        detours: detours.map(({ id: detourId, requirementId, ...detail }) => detail),
      }))
    expect(strip(copied)).toEqual(strip(source))
    expect(copied.find((row) => row.key === 'a')).toMatchObject({ weight: 2.5, anchors: ANCHORS })
    expect(copied.find((row) => row.key === 'b')?.weight).toBeNull()
  })

  test('gives the copy rows of its own, so editing the new version leaves the source alone', async () => {
    // Arrange / Act
    const { source, copied } = await withMigratedScratchDatabase(async (db) => {
      const { setId } = await judgedSet(db)
      const created = await createCriteriaVersion(db, { fromSetId: setId })
      const target = (await getRequirements(db, created.id)).find((row) => row.key === 'a')
      if (!target) throw new Error('the copy has no requirement a')
      await updateRequirement(db, target.id, { weight: 9 })
      const [detourCount] = await db.select({ total: count() }).from(detour)
      return { source: await getRequirements(db, setId), copied: detourCount?.total }
    })

    // Assert
    expect(source.find((row) => row.key === 'a')?.weight).toBe(2.5)
    expect(copied).toBe(4)
  })

  test('does not make the new version the default, even when the source is', async () => {
    // Arrange / Act
    const { created, sets } = await withMigratedScratchDatabase(async (db) => {
      const { setId } = await judgedSet(db)
      await setDefaultCriteriaSet(db, setId)
      const created = await createCriteriaVersion(db, { fromSetId: setId })
      return { created, sets: await listCriteriaSets(db) }
    })

    // Assert
    expect(created.isDefault).toBe(false)
    expect(sets.filter((row) => row.isDefault)).toHaveLength(1)
    expect(sets.find((row) => row.isDefault)?.version).toBe(1)
  })

  test('takes a name when one is given, and numbers from that name, not from the source', async () => {
    // Arrange / Act
    const { renamed, again } = await withMigratedScratchDatabase(async (db) => {
      const set = await insertCriteriaSet(db, { name: 'Base', version: 4 })
      const renamed = await createCriteriaVersion(db, { fromSetId: set.id, name: 'Renamed' })
      return { renamed, again: await createCriteriaVersion(db, { fromSetId: set.id, name: 'Renamed' }) }
    })

    // Assert
    expect(renamed).toMatchObject({ name: 'Renamed', version: 1, applyThreshold: null })
    expect(again).toMatchObject({ name: 'Renamed', version: 2 })
  })

  test('copying v1 while v2 and v3 exist makes v4, carrying v1 weights and threshold', async () => {
    // Arrange / Act
    const { created, copied } = await withMigratedScratchDatabase(async (db) => {
      const { setId } = await judgedSet(db)
      const second = await createCriteriaVersion(db, { fromSetId: setId })
      const secondRequirement = (await getRequirements(db, second.id)).find((row) => row.key === 'a')
      if (!secondRequirement) throw new Error('v2 has no requirement a')
      await updateRequirement(db, secondRequirement.id, { weight: 9 })
      await db.update(criteriaSet).set({ applyThreshold: 0.9 }).where(eq(criteriaSet.id, second.id))
      await createCriteriaVersion(db, { fromSetId: second.id })
      const created = await createCriteriaVersion(db, { fromSetId: setId })
      return { created, copied: await getRequirements(db, created.id) }
    })

    // Assert
    expect(created).toMatchObject({ name: 'Mine', version: 4, applyThreshold: 0.6 })
    expect(copied.find((row) => row.key === 'a')?.weight).toBe(2.5)
  })

  test('numbers past an archived version too, so a retired number is not reused', async () => {
    // Arrange / Act
    const created = await withMigratedScratchDatabase(async (db) => {
      const first = await insertCriteriaSet(db, { name: 'Line' })
      await insertCriteriaSet(db, { name: 'Line', version: 2, archivedAt: new Date() })
      return createCriteriaVersion(db, { fromSetId: first.id })
    })

    // Assert
    expect(created.version).toBe(3)
  })

  test('gives two connections creating a version at the same moment two different numbers', async () => {
    // Arrange / Act
    const { outcomes, versions } = await withMigratedScratchDatabase(async (db, sql) => {
      const url = new URL(process.env.DATABASE_URL ?? '')
      url.pathname = `/${sql.options.database}`
      const second = postgres(url.toString(), { max: 1, onnotice: () => {} })
      try {
        const other = drizzle(second)
        const { setId } = await judgedSet(db)
        const outcomes = await Promise.allSettled(
          Array.from({ length: 8 }, (_, index) => createCriteriaVersion(index % 2 === 0 ? db : other, { fromSetId: setId })),
        )
        return { outcomes, versions: (await listCriteriaSets(db)).map((row) => row.version).sort((a, b) => a - b) }
      } finally {
        await second.end()
      }
    })

    // Assert
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toEqual([])
    expect(versions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  test('copies a set with no requirements, and a vanilla set with no judgement stays without any', async () => {
    // Arrange / Act
    const { created, copied } = await withMigratedScratchDatabase(async (db) => {
      const set = await insertCriteriaSet(db, { name: 'Pack' })
      const created = await createCriteriaVersion(db, { fromSetId: set.id })
      return { created, copied: await getRequirements(db, created.id) }
    })

    // Assert
    expect(created.applyThreshold).toBeNull()
    expect(copied).toEqual([])
  })

  test('does not carry an archived state to the copy', async () => {
    // Arrange / Act
    const created = await withMigratedScratchDatabase(async (db) => {
      const set = await insertCriteriaSet(db, { name: 'Old', archivedAt: new Date() })
      return createCriteriaVersion(db, { fromSetId: set.id })
    })

    // Assert
    expect(created.archivedAt).toBeNull()
  })

  test('refuses a source that does not exist', async () => {
    // Arrange / Act
    const error = await withMigratedScratchDatabase((db) => thrownBy(() => createCriteriaVersion(db, { fromSetId: 4242 })))

    // Assert
    expect(error).toBeInstanceOf(NotFoundError)
  })
})

describe('setDefaultCriteriaSet', () => {
  test('moves the single default slot', async () => {
    // Arrange / Act
    const { afterFirst, afterSecond, ids } = await withMigratedScratchDatabase(async (db) => {
      const first = await insertCriteriaSet(db, { name: 'One' })
      const second = await insertCriteriaSet(db, { name: 'Two' })
      await setDefaultCriteriaSet(db, first.id)
      const afterFirst = (await listCriteriaSets(db)).filter((row) => row.isDefault).map((row) => row.id)
      await setDefaultCriteriaSet(db, second.id)
      const afterSecond = (await listCriteriaSets(db)).filter((row) => row.isDefault).map((row) => row.id)
      return { afterFirst, afterSecond, ids: { first: first.id, second: second.id } }
    })

    // Assert
    expect(afterFirst).toEqual([ids.first])
    expect(afterSecond).toEqual([ids.second])
  })

  test('is a no-op in effect when the set already is the default', async () => {
    // Arrange / Act
    const defaults = await withMigratedScratchDatabase(async (db) => {
      const set = await insertCriteriaSet(db, { name: 'One', isDefault: true })
      await setDefaultCriteriaSet(db, set.id)
      return (await listCriteriaSets(db)).filter((row) => row.isDefault)
    })

    // Assert
    expect(defaults).toHaveLength(1)
  })

  test('on an archived set throws, and leaves the current default in place', async () => {
    // Arrange / Act
    const { error, defaults } = await withMigratedScratchDatabase(async (db) => {
      await insertCriteriaSet(db, { name: 'Current', isDefault: true })
      const archived = await insertCriteriaSet(db, { name: 'Archived', archivedAt: new Date() })
      const error = await thrownBy(() => setDefaultCriteriaSet(db, archived.id))
      return { error, defaults: (await listCriteriaSets(db)).filter((row) => row.isDefault).map((row) => row.name) }
    })

    // Assert
    expect(error).toBeInstanceOf(ArchivedError)
    expect(statusFor(error)).toBe(409)
    expect(defaults).toEqual(['Current'])
  })

  test('on a set that does not exist throws NotFoundError and keeps the current default', async () => {
    // Arrange / Act
    const { error, defaults } = await withMigratedScratchDatabase(async (db) => {
      await insertCriteriaSet(db, { name: 'Current', isDefault: true })
      const error = await thrownBy(() => setDefaultCriteriaSet(db, 777))
      return { error, defaults: (await listCriteriaSets(db)).filter((row) => row.isDefault).length }
    })

    // Assert
    expect(error).toBeInstanceOf(NotFoundError)
    expect(defaults).toBe(1)
  })

  test('leaves exactly one default when two connections move it at the same moment', async () => {
    // Arrange / Act
    const { outcomes, defaults } = await withMigratedScratchDatabase(async (db, sql) => {
      const url = new URL(process.env.DATABASE_URL ?? '')
      url.pathname = `/${sql.options.database}`
      const second = postgres(url.toString(), { max: 1, onnotice: () => {} })
      try {
        const other = drizzle(second)
        const ids = [
          idOf([await insertCriteriaSet(db, { name: 'A' })]),
          idOf([await insertCriteriaSet(db, { name: 'B' })]),
          idOf([await insertCriteriaSet(db, { name: 'C' })]),
        ]
        const attempts = Array.from({ length: 12 }, (_, index) =>
          setDefaultCriteriaSet(index % 2 === 0 ? db : other, ids[index % ids.length] ?? 0),
        )
        const outcomes = await Promise.allSettled(attempts)
        return { outcomes, defaults: (await listCriteriaSets(db)).filter((row) => row.isDefault) }
      } finally {
        await second.end()
      }
    })

    // Assert
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toEqual([])
    expect(defaults).toHaveLength(1)
  })
})

describe('updateRequirement', () => {
  test('changes weight, kind, label and anchors, and returns the row with its layer label and detours', async () => {
    // Arrange / Act
    const updated = await withMigratedScratchDatabase(async (db) => {
      const { setId } = await judgedSet(db)
      const target = (await getRequirements(db, setId)).find((row) => row.key === 'a')
      if (!target) throw new Error('no requirement a')
      return updateRequirement(db, target.id, {
        weight: 4,
        kind: 'gate',
        label: 'Renamed',
        anchors: { '0': 'x', '0.5': 'y', '1': 'z' },
      })
    })

    // Assert
    expect(updated).toMatchObject({
      weight: 4,
      kind: 'gate',
      label: 'Renamed',
      anchors: { '0': 'x', '0.5': 'y', '1': 'z' },
      layerLabel: 'Layer of Mine',
      key: 'a',
    })
    expect(updated.detours).toHaveLength(2)
  })

  test('accepts a null weight, which means no weight is set', async () => {
    // Arrange / Act
    const updated = await withMigratedScratchDatabase(async (db) => {
      const { setId } = await judgedSet(db)
      const target = (await getRequirements(db, setId)).find((row) => row.key === 'a')
      if (!target) throw new Error('no requirement a')
      return updateRequirement(db, target.id, RequirementPatchSchema.parse({ weight: null }))
    })

    // Assert
    expect(updated.weight).toBeNull()
  })

  test('accepts a weight of zero, which records a requirement without scoring it', async () => {
    // Arrange / Act
    const updated = await withMigratedScratchDatabase(async (db) => {
      const { setId } = await judgedSet(db)
      const target = (await getRequirements(db, setId)).find((row) => row.key === 'a')
      if (!target) throw new Error('no requirement a')
      return updateRequirement(db, target.id, { weight: 0 })
    })

    // Assert
    expect(updated.weight).toBe(0)
  })

  test('leaves what the patch does not name untouched', async () => {
    // Arrange / Act
    const updated = await withMigratedScratchDatabase(async (db) => {
      const { setId } = await judgedSet(db)
      const target = (await getRequirements(db, setId)).find((row) => row.key === 'a')
      if (!target) throw new Error('no requirement a')
      return updateRequirement(db, target.id, { label: 'Only the label' })
    })

    // Assert
    expect(updated).toMatchObject({ label: 'Only the label', weight: 2.5, kind: 'soft', anchors: ANCHORS })
  })

  test('writes only the four editable columns, however wide the object it is handed', async () => {
    // Arrange / Act
    const { updated, other } = await withMigratedScratchDatabase(async (db) => {
      const { setId } = await judgedSet(db)
      const rows = await getRequirements(db, setId)
      const target = rows.find((row) => row.key === 'a')
      const bystander = await insertCriteriaSet(db, { name: 'Bystander' })
      if (!target) throw new Error('no requirement a')
      const wide = { weight: 1, id: 9999, criteriaSetId: bystander.id, key: 'hijacked', sort: 77 }
      return { updated: await updateRequirement(db, target.id, wide), other: setId }
    })

    // Assert
    expect(updated).toMatchObject({ weight: 1, key: 'a', sort: 1, criteriaSetId: other })
    expect(updated.id).not.toBe(9999)
  })

  test('with an empty patch returns the row unchanged instead of issuing an empty update', async () => {
    // Arrange / Act
    const { before, after } = await withMigratedScratchDatabase(async (db) => {
      const { setId } = await judgedSet(db)
      const before = (await getRequirements(db, setId)).find((row) => row.key === 'a')
      if (!before) throw new Error('no requirement a')
      return { before, after: await updateRequirement(db, before.id, {}) }
    })

    // Assert
    expect(after).toEqual(before)
  })

  test('refuses a requirement that does not exist', async () => {
    // Arrange / Act
    const error = await withMigratedScratchDatabase((db) => thrownBy(() => updateRequirement(db, 31337, { weight: 1 })))

    // Assert
    expect(error).toBeInstanceOf(NotFoundError)
  })
})

describe('RequirementPatchSchema', () => {
  test('refuses a weight of Infinity at the schema', () => {
    expect(RequirementPatchSchema.safeParse({ weight: Infinity }).success).toBe(false)
    expect(RequirementPatchSchema.safeParse({ weight: -Infinity }).success).toBe(false)
  })

  test('refuses NaN, a negative weight and a weight that is text', () => {
    expect(RequirementPatchSchema.safeParse({ weight: Number.NaN }).success).toBe(false)
    expect(RequirementPatchSchema.safeParse({ weight: -1 }).success).toBe(false)
    expect(RequirementPatchSchema.safeParse({ weight: '2' }).success).toBe(false)
  })

  test('accepts null, zero and a finite weight', () => {
    expect(RequirementPatchSchema.safeParse({ weight: null }).success).toBe(true)
    expect(RequirementPatchSchema.safeParse({ weight: 0 }).success).toBe(true)
    expect(RequirementPatchSchema.safeParse({ weight: 3.5 }).success).toBe(true)
  })

  test('refuses a field it does not name, rather than dropping it', () => {
    expect(RequirementPatchSchema.safeParse({ weight: 1, importance: 5 }).success).toBe(false)
    expect(RequirementPatchSchema.safeParse({ layerId: 3 }).success).toBe(false)
  })

  test('refuses an empty patch, a kind outside gate and soft, and a blank label', () => {
    expect(RequirementPatchSchema.safeParse({}).success).toBe(false)
    expect(RequirementPatchSchema.safeParse({ kind: 'maybe' }).success).toBe(false)
    expect(RequirementPatchSchema.safeParse({ label: '   ' }).success).toBe(false)
  })

  test('refuses a NUL byte in the label and anywhere in the anchors', () => {
    expect(RequirementPatchSchema.safeParse({ label: 'a\u0000b' }).success).toBe(false)
    expect(RequirementPatchSchema.safeParse({ anchors: { '0': 'a\u0000', '0.5': 'b', '1': 'c' } }).success).toBe(false)
  })

  test('requires all three anchors, each non-empty, and no others', () => {
    expect(RequirementPatchSchema.safeParse({ anchors: { '0': 'a', '1': 'c' } }).success).toBe(false)
    expect(RequirementPatchSchema.safeParse({ anchors: { '0': 'a', '0.5': ' ', '1': 'c' } }).success).toBe(false)
    expect(RequirementPatchSchema.safeParse({ anchors: { '0': 'a', '0.5': 'b', '1': 'c', '2': 'd' } }).success).toBe(false)
  })
})

describe('the other criteria schemas', () => {
  test('a version input needs a source id, takes an optional name, and refuses NUL and unknown keys', () => {
    expect(CriteriaVersionInputSchema.parse({ fromSetId: '3' })).toEqual({ fromSetId: 3 })
    expect(CriteriaVersionInputSchema.parse({ fromSetId: 3, name: ' Next ' })).toEqual({ fromSetId: 3, name: 'Next' })
    expect(CriteriaVersionInputSchema.safeParse({ fromSetId: 3, name: 'a\u0000' }).success).toBe(false)
    expect(CriteriaVersionInputSchema.safeParse({ fromSetId: 3, name: '' }).success).toBe(false)
    expect(CriteriaVersionInputSchema.safeParse({ name: 'x' }).success).toBe(false)
    expect(CriteriaVersionInputSchema.safeParse({ fromSetId: 3, version: 9 }).success).toBe(false)
  })

  test('a set query takes includeArchived as a boolean or its text form, and nothing else', () => {
    expect(CriteriaSetQuerySchema.parse({})).toEqual({})
    expect(CriteriaSetQuerySchema.parse({ includeArchived: 'true' })).toEqual({ includeArchived: true })
    expect(CriteriaSetQuerySchema.safeParse({ includeArchived: 'yes' }).success).toBe(false)
    expect(CriteriaSetQuerySchema.safeParse({ limit: 5 }).success).toBe(false)
  })
})

describe('the unique constraint behind createCriteriaVersion', () => {
  test('turns a version claimed by an uncommitted writer into a ConflictError, with nothing copied', async () => {
    // Arrange / Act: another connection inserts v2 and holds it open, so the version read cannot see it
    const { error, requirementCount } = await withMigratedScratchDatabase(async (db, sql) => {
      const url = new URL(process.env.DATABASE_URL ?? '')
      url.pathname = `/${sql.options.database}`
      const writer = postgres(url.toString(), { max: 1, onnotice: () => {} })
      const observer = postgres(url.toString(), { max: 1, onnotice: () => {} })
      try {
        const { setId } = await judgedSet(db)
        const before = (await db.select({ total: count() }).from(requirement))[0]?.total
        let attempt: Promise<unknown> = Promise.resolve()
        await writer.begin(async (transaction) => {
          await transaction`insert into criteria_set (name, version) values ('Mine', 2)`
          attempt = thrownBy(() => createCriteriaVersion(db, { fromSetId: setId }))
          await waitUntilABackendWaitsOnALock(observer)
        })
        const error = await attempt
        const after = (await db.select({ total: count() }).from(requirement))[0]?.total
        return { error, requirementCount: [before, after] }
      } finally {
        await writer.end()
        await observer.end()
      }
    })

    // Assert
    expect(error).toBeInstanceOf(CriteriaSetConflictError)
    expect(error).toBeInstanceOf(ConflictError)
    expect(statusFor(error)).toBe(409)
    expect((error as Error).message).not.toMatch(/insert|select|duplicate key/i)
    expect((error as Error).cause).toBeDefined()
    expect(requirementCount[0]).toBe(requirementCount[1])
  })
})

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
