import { describe, expect, test } from 'bun:test'
import { count } from 'drizzle-orm'

import {
  addRegistryRows,
  archiveRegistryRow,
  assertNotArchived,
  listRegistry,
  REGISTRY_TABLES,
} from '../../src/data/repositories/registries.ts'
import { ArchivedError, ConflictError, NotFoundError, statusFor } from '../../src/errors.ts'
import { BULK_MAX, bulkOf, IdSchema, PAGE_LIMIT_MAX, PaginationSchema } from '../../src/schemas/common.ts'
import { REGISTRY_SCHEMAS } from '../../src/schemas/registries.ts'
import { thrownBy } from '../data/rolled-back.ts'
import { withMigratedScratchDatabase } from '../data/scratch-database.ts'

const REGISTRY_NAMES = [
  'apply_route',
  'artefact_kind',
  'layer',
  'penalty_kind',
  'phase',
  'rejection_reason',
  'route',
  'seniority',
  'set_aside_reason',
  'stage',
  'text_type',
  'work_format',
]

/** The id at `index`, or a loud failure: an absent row would otherwise read as a pass. */
function idOf(rows: readonly { readonly id: number }[], index = 0): number {
  const id = rows[index]?.id
  if (id === undefined) throw new Error(`the arrangement produced no row at index ${index}`)
  return id
}

describe('the registry record', () => {
  test('every registry in the spec has a table and a schema', () => {
    // Assert: twelve registries, and the two records agree, so a thirteenth added to one
    // of them fails here until it is added to both
    expect(Object.keys(REGISTRY_TABLES).sort()).toEqual(REGISTRY_NAMES)
    expect(Object.keys(REGISTRY_SCHEMAS).sort()).toEqual(Object.keys(REGISTRY_TABLES).sort())
  })
})

describe('listRegistry', () => {
  test('hides archived rows by default and returns them on request', async () => {
    // Arrange / Act
    const { pickable, everything } = await withMigratedScratchDatabase(async (db) => {
      const added = await addRegistryRows(db, 'route', [{ label: 'Kept' }, { label: 'Retired' }])
      await archiveRegistryRow(db, 'route', idOf(added, 1))
      return {
        pickable: await listRegistry(db, 'route'),
        everything: await listRegistry(db, 'route', { includeArchived: true }),
      }
    })

    // Assert
    expect(pickable.map((row) => row.label)).toEqual(['Kept'])
    expect(everything.map((row) => row.label)).toEqual(['Kept', 'Retired'])
  })

  test('returns nothing for a registry that has not been filled in', async () => {
    // Arrange / Act: the template ships every registry empty
    const rows = await withMigratedScratchDatabase((db) => listRegistry(db, 'work_format'))

    // Assert
    expect(rows).toEqual([])
  })

  test('keeps the extra columns of a wider registry', async () => {
    // Arrange / Act
    const rows = await withMigratedScratchDatabase(async (db) => {
      await addRegistryRows(db, 'phase', [{ key: 'p1', label: 'A phase', isShortlist: true }])
      return listRegistry(db, 'phase')
    })

    // Assert: a phase carries key, sort and the user-set flag, not just id and label
    expect(rows[0]?.key).toBe('p1')
    expect(rows[0]?.sort).toBe(0)
    expect(rows[0]?.isShortlist).toBe(true)
  })

  test('returns the rows of an ordered registry in the order the user set', async () => {
    // Arrange / Act: inserted out of order, so an id ordering would fail this
    const rows = await withMigratedScratchDatabase(async (db) => {
      await addRegistryRows(db, 'seniority', [
        { label: 'Later', sort: 2 },
        { label: 'Earlier', sort: 1 },
      ])
      return listRegistry(db, 'seniority')
    })

    // Assert
    expect(rows.map((row) => row.label)).toEqual(['Earlier', 'Later'])
  })
})

describe('archival is not deletion', () => {
  test('an archived row keeps its label, because a row that named it still renders', async () => {
    // Arrange / Act: a stage names a phase, and the phase is archived afterwards
    const { archived, pickable, labelOfReference } = await withMigratedScratchDatabase(async (db) => {
      const phases = await addRegistryRows(db, 'phase', [{ key: 'p1', label: 'Named phase' }])
      const phaseId = idOf(phases)
      const stages = await addRegistryRows(db, 'stage', [{ key: 's1', label: 'A stage', phaseId }])
      const archived = await archiveRegistryRow(db, 'phase', phaseId)
      const everyPhase = await listRegistry(db, 'phase', { includeArchived: true })
      const labels = new Map(everyPhase.map((row) => [row.id, row.label]))
      const namedByTheStage = stages[0]?.phaseId ?? null
      return {
        archived,
        pickable: await listRegistry(db, 'phase'),
        labelOfReference: namedByTheStage === null ? null : labels.get(namedByTheStage),
      }
    })

    // Assert: the reference still resolves to a label, and the row is no longer offered
    expect(archived.label).toBe('Named phase')
    expect(archived.archivedAt).not.toBeNull()
    expect(labelOfReference).toBe('Named phase')
    expect(pickable).toEqual([])
  })

  test('a write naming an archived registry row is refused and leaves nothing behind', async () => {
    // Arrange / Act
    const { error, stageCount } = await withMigratedScratchDatabase(async (db) => {
      const phases = await addRegistryRows(db, 'phase', [{ key: 'p1', label: 'Retired phase' }])
      const phaseId = idOf(phases)
      await archiveRegistryRow(db, 'phase', phaseId)
      const error = await thrownBy(() =>
        addRegistryRows(db, 'stage', [{ key: 's1', label: 'A stage', phaseId }]),
      )
      const counted = await db.select({ n: count() }).from(REGISTRY_TABLES.stage)
      return { error, stageCount: counted[0]?.n }
    })

    // Assert
    expect(error).toBeInstanceOf(ArchivedError)
    expect(stageCount).toBe(0)
  })

  test('archiveRegistryRow on an already archived row changes nothing and does not throw', async () => {
    // Arrange / Act
    const { first, second } = await withMigratedScratchDatabase(async (db) => {
      const added = await addRegistryRows(db, 'penalty_kind', [{ label: 'Retired kind' }])
      const id = idOf(added)
      const first = await archiveRegistryRow(db, 'penalty_kind', id)
      return { first, second: await archiveRegistryRow(db, 'penalty_kind', id) }
    })

    // Assert: the second call reports the same archival instant, so it wrote nothing
    expect(first.archivedAt).not.toBeNull()
    expect(second.archivedAt).toEqual(first.archivedAt)
  })

  test('archiveRegistryRow throws NotFoundError for an id that was never there', async () => {
    // Arrange / Act
    const error = await withMigratedScratchDatabase((db) =>
      thrownBy(() => archiveRegistryRow(db, 'route', 4321)),
    )

    // Assert
    expect(error).toBeInstanceOf(NotFoundError)
  })
})

describe('assertNotArchived', () => {
  test('passes for a row that is still in use', async () => {
    // Arrange / Act
    const error = await withMigratedScratchDatabase(async (db) => {
      const added = await addRegistryRows(db, 'route', [{ label: 'In use' }])
      return thrownBy(() => assertNotArchived(db, 'route', idOf(added)))
    })

    // Assert
    expect(error).toBeUndefined()
  })

  test('throws ArchivedError for an archived row', async () => {
    // Arrange / Act
    const error = await withMigratedScratchDatabase(async (db) => {
      const added = await addRegistryRows(db, 'route', [{ label: 'Retired' }])
      const id = idOf(added)
      await archiveRegistryRow(db, 'route', id)
      return thrownBy(() => assertNotArchived(db, 'route', id))
    })

    // Assert
    expect(error).toBeInstanceOf(ArchivedError)
  })

  test('throws NotFoundError for an id that was never there', async () => {
    // Arrange / Act
    const error = await withMigratedScratchDatabase((db) =>
      thrownBy(() => assertNotArchived(db, 'route', 1234)),
    )

    // Assert
    expect(error).toBeInstanceOf(NotFoundError)
  })
})

describe('addRegistryRows', () => {
  test('returns the rows it created, in the order they were given', async () => {
    // Arrange / Act
    const added = await withMigratedScratchDatabase((db) =>
      addRegistryRows(db, 'text_type', [{ label: 'Cover letter' }, { label: 'Form answer' }]),
    )

    // Assert
    expect(added.map((row) => row.label)).toEqual(['Cover letter', 'Form answer'])
    expect(added.every((row) => row.archivedAt === null)).toBe(true)
  })

  test('takes an open transaction, which is why Db accepts one', async () => {
    // Arrange / Act: one write commits with its transaction, the next rolls back with its own
    const { committed, afterRollback } = await withMigratedScratchDatabase(async (db) => {
      const committed = await db.transaction((tx) => addRegistryRows(tx, 'route', [{ label: 'Kept' }]))
      await thrownBy(() =>
        db.transaction(async (tx) => {
          await addRegistryRows(tx, 'route', [{ label: 'Undone' }])
          throw new Error('the caller gave up after the write')
        }),
      )
      return { committed, afterRollback: await listRegistry(db, 'route') }
    })

    // Assert
    expect(committed.map((row) => row.label)).toEqual(['Kept'])
    expect(afterRollback.map((row) => row.label)).toEqual(['Kept'])
  })

  test('reports a key the registry already holds as a conflict, not an internal error', async () => {
    // Arrange / Act: only phase, stage and layer have a unique key column
    const error = await withMigratedScratchDatabase(async (db) => {
      await addRegistryRows(db, 'phase', [{ key: 'p1', label: 'A phase' }])
      return thrownBy(() => addRegistryRows(db, 'phase', [{ key: 'p1', label: 'Another phase' }]))
    })

    // Assert: the caller is told which key collided, and the surface sends 409, not 500
    expect(error).toBeInstanceOf(ConflictError)
    expect((error as ConflictError).field).toBe('phase key')
    expect((error as ConflictError).key).toBe('p1')
    expect(statusFor(error)).toBe(409)
    expect((error as Error).cause).toBeDefined()
  })

  test('counts the keys rather than listing them when a long bulk call conflicts', async () => {
    // Arrange / Act: more keys than a message should list, the first of which already exists
    const error = await withMigratedScratchDatabase(async (db) => {
      await addRegistryRows(db, 'phase', [{ key: 'p1', label: 'A phase' }])
      const many = Array.from({ length: 6 }, (_, index) => ({
        key: `p${index + 1}`,
        label: `Phase ${index + 1}`,
      }))
      return thrownBy(() => addRegistryRows(db, 'phase', many))
    })

    // Assert: Postgres reports the constraint and not the row, so the message says so
    expect(error).toBeInstanceOf(ConflictError)
    expect((error as ConflictError).key).toBe('one of the 6 values this call carried')
  })

  test('rethrows a failure that is not the key conflict, unchanged', async () => {
    // Arrange / Act: a layer with no key and a route with no label, both of which the
    // registry's own schema refuses, so the casts are how a test reaches the driver errors
    // the catch block must leave alone. Layer has a unique key column; route has none.
    const { keyed, keyless } = await withMigratedScratchDatabase(async (db) => ({
      keyed: await thrownBy(() => addRegistryRows(db, 'layer', [{ label: 'No key' } as never])),
      keyless: await thrownBy(() => addRegistryRows(db, 'route', [{ label: null } as never])),
    }))

    // Assert: a not-null violation is not reshaped into a conflict, with or without a key column
    expect(keyed).toBeInstanceOf(Error)
    expect(keyed).not.toBeInstanceOf(ConflictError)
    expect(keyless).toBeInstanceOf(Error)
    expect(keyless).not.toBeInstanceOf(ConflictError)
  })

  test('writes nothing for an empty list', async () => {
    // Arrange / Act: the bulk schema already refuses an empty list, so this is the belt
    const { added, stored } = await withMigratedScratchDatabase(async (db) => ({
      added: await addRegistryRows(db, 'route', []),
      stored: await listRegistry(db, 'route'),
    }))

    // Assert
    expect(added).toEqual([])
    expect(stored).toEqual([])
  })
})

describe('the bulk envelope', () => {
  test('rejects more than BULK_MAX items at the schema', () => {
    // Arrange / Act
    const parsed = bulkOf(REGISTRY_SCHEMAS.route).safeParse({
      items: Array(BULK_MAX + 1).fill({ label: 'x' }),
    })

    // Assert
    expect(parsed.success).toBe(false)
  })

  test('accepts exactly BULK_MAX items and refuses an empty list', () => {
    // Arrange
    const schema = bulkOf(REGISTRY_SCHEMAS.route)

    // Act
    const atTheCap = schema.safeParse({ items: Array(BULK_MAX).fill({ label: 'x' }) })
    const empty = schema.safeParse({ items: [] })

    // Assert
    expect(atTheCap.success).toBe(true)
    expect(empty.success).toBe(false)
  })
})

describe('the registry schemas', () => {
  test('refuse a blank label and trim the one they accept', () => {
    // Act
    const blank = REGISTRY_SCHEMAS.route.safeParse({ label: '   ' })
    const padded = REGISTRY_SCHEMAS.route.safeParse({ label: '  Careers page  ' })

    // Assert
    expect(blank.success).toBe(false)
    expect(padded.success && padded.data.label).toBe('Careers page')
  })

  test('refuse a field the registry does not have', () => {
    // Act: a flag only phase carries, sent to a registry that has no flags
    const parsed = REGISTRY_SCHEMAS.route.safeParse({ label: 'Careers page', isShortlist: true })

    // Assert
    expect(parsed.success).toBe(false)
  })

  test('require the key that a keyed registry has', () => {
    // Act
    const withoutKey = REGISTRY_SCHEMAS.phase.safeParse({ label: 'A phase' })
    const withKey = REGISTRY_SCHEMAS.phase.safeParse({ key: 'p1', label: 'A phase' })

    // Assert
    expect(withoutKey.success).toBe(false)
    expect(withKey.success).toBe(true)
  })
})

describe('the shared input schemas', () => {
  test('IdSchema takes a number or the numeric string an HTTP path carries', () => {
    // Act / Assert
    expect(IdSchema.parse(7)).toBe(7)
    expect(IdSchema.parse('7')).toBe(7)
    expect(IdSchema.safeParse(0).success).toBe(false)
    expect(IdSchema.safeParse(-1).success).toBe(false)
    expect(IdSchema.safeParse(1.5).success).toBe(false)
    expect(IdSchema.safeParse('').success).toBe(false)
    expect(IdSchema.safeParse(true).success).toBe(false)
  })

  test('PaginationSchema fills in a page when the caller asks for none', () => {
    // Act
    const defaults = PaginationSchema.parse({})
    const fromQueryString = PaginationSchema.parse({ limit: '10', offset: '20' })

    // Assert
    expect(defaults.offset).toBe(0)
    expect(defaults.limit).toBeGreaterThan(0)
    expect(fromQueryString).toEqual({ limit: 10, offset: 20 })
  })

  test('PaginationSchema refuses a limit no single-user database should serve', () => {
    // Act / Assert
    expect(PaginationSchema.safeParse({ limit: 0 }).success).toBe(false)
    expect(PaginationSchema.safeParse({ limit: PAGE_LIMIT_MAX + 1 }).success).toBe(false)
    expect(PaginationSchema.safeParse({ offset: -1 }).success).toBe(false)
  })
})
