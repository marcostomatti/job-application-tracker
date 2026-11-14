import { describe, expect, test } from 'bun:test'
import { count } from 'drizzle-orm'

import {
  addRegistryRows,
  archiveRegistryRow,
  assertNotArchived,
  findRegistryRow,
  listRegistry,
  REGISTRY_TABLES,
  updateRegistryRow,
} from '../../src/data/repositories/registries.ts'
import { ArchivedError, ConflictError, NotFoundError, statusFor } from '../../src/errors.ts'
import { thrownBy } from '../data/rolled-back.ts'
import { withMigratedScratchDatabase } from '../data/scratch-database.ts'

/** The id at `index`, or a loud failure: an absent row would otherwise read as a pass. */
function idOf(rows: readonly { readonly id: number }[], index = 0): number {
  const id = rows[index]?.id
  if (id === undefined) throw new Error(`the arrangement produced no row at index ${index}`)
  return id
}

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

describe('updateRegistryRow', () => {
  test('changes the named columns of a row in place and keeps its key and every other column', async () => {
    // Arrange / Act
    const { before, after } = await withMigratedScratchDatabase(async (db) => {
      const created = await addRegistryRows(db, 'stage', [{ key: 'gated', label: 'Closed by a gate', isTerminal: true, isApplied: true }])
      const before = await findRegistryRow(db, 'stage', idOf(created))
      const after = await updateRegistryRow(db, 'stage', before.id, { isApplied: false, label: 'Closed: gate' })
      return { before, after }
    })

    // Assert
    expect(after).toEqual({ ...before, isApplied: false, label: 'Closed: gate' })
  })

  test('an empty patch returns the row as it is', async () => {
    // Arrange / Act
    const { before, after } = await withMigratedScratchDatabase(async (db) => {
      const created = await addRegistryRows(db, 'phase', [{ key: 'open', label: 'Open', isShortlist: true }])
      const before = await findRegistryRow(db, 'phase', idOf(created))
      const after = await updateRegistryRow(db, 'phase', before.id, {})
      return { before, after }
    })

    // Assert
    expect(after).toEqual(before)
  })

  test('throws NotFoundError for an id that was never there', async () => {
    // Arrange / Act
    const error = await withMigratedScratchDatabase(async (db) =>
      thrownBy(() => updateRegistryRow(db, 'route', 999_999, { label: 'Nobody' })),
    )

    // Assert
    expect(error).toBeInstanceOf(NotFoundError)
  })

  test('refuses to move a stage onto a phase that does not exist, as not-found', async () => {
    // Arrange / Act
    const error = await withMigratedScratchDatabase(async (db) => {
      const [stage] = await addRegistryRows(db, 'stage', [{ key: 'orphan_bound', label: 'Orphan bound' }])
      if (!stage) throw new Error('the arrangement stored no stage')
      return thrownBy(() => updateRegistryRow(db, 'stage', stage.id, { phaseId: 999_999 }))
    })

    // Assert
    expect(error).toBeInstanceOf(NotFoundError)
  })

  test('refuses to move a stage onto an archived phase and changes nothing', async () => {
    // Arrange / Act
    const { error, stored } = await withMigratedScratchDatabase(async (db) => {
      const phases = await addRegistryRows(db, 'phase', [{ key: 'live', label: 'Live' }, { key: 'old', label: 'Old' }])
      await archiveRegistryRow(db, 'phase', idOf(phases, 1))
      const stages = await addRegistryRows(db, 'stage', [{ key: 's', label: 'Stage', phaseId: idOf(phases) }])
      const error = await thrownBy(() => updateRegistryRow(db, 'stage', idOf(stages), { phaseId: idOf(phases, 1) }))
      const stored = await findRegistryRow(db, 'stage', idOf(stages))
      return { error, stored }
    })

    // Assert
    expect(error).toBeInstanceOf(ArchivedError)
    expect(stored.label).toBe('Stage')
  })

  test('accepts an unchanged phase that was archived after the stage named it', async () => {
    // Arrange / Act
    const updated = await withMigratedScratchDatabase(async (db) => {
      const phases = await addRegistryRows(db, 'phase', [{ key: 'p', label: 'Phase' }])
      const stages = await addRegistryRows(db, 'stage', [{ key: 's', label: 'Stage', phaseId: idOf(phases) }])
      await archiveRegistryRow(db, 'phase', idOf(phases))
      return updateRegistryRow(db, 'stage', idOf(stages), { phaseId: idOf(phases), label: 'Renamed' })
    })

    // Assert
    expect(updated.label).toBe('Renamed')
  })

  test('updates an archived row and keeps it archived', async () => {
    // Arrange / Act
    const updated = await withMigratedScratchDatabase(async (db) => {
      const rows = await addRegistryRows(db, 'route', [{ label: 'Refferal' }])
      await archiveRegistryRow(db, 'route', idOf(rows))
      return updateRegistryRow(db, 'route', idOf(rows), { label: 'Referral' })
    })

    // Assert
    expect(updated.label).toBe('Referral')
    expect(updated.archivedAt).not.toBeNull()
  })

  test('writes no column outside the patch, even one an untyped caller smuggles in', async () => {
    // Arrange / Act
    const stored = await withMigratedScratchDatabase(async (db) => {
      const rows = await addRegistryRows(db, 'layer', [{ key: 'market', label: 'Market' }])
      const smuggled = { label: 'Market layer', key: 'renamed', archivedAt: new Date() } as unknown as { label: string }
      await updateRegistryRow(db, 'layer', idOf(rows), smuggled)
      return findRegistryRow(db, 'layer', idOf(rows))
    })

    // Assert
    expect(stored).toMatchObject({ key: 'market', label: 'Market layer', archivedAt: null })
  })
})

describe('findRegistryRow', () => {
  test('returns a row that is still in use', async () => {
    // Arrange / Act
    const found = await withMigratedScratchDatabase(async (db) => {
      const added = await addRegistryRows(db, 'route', [{ label: 'In use' }])
      return findRegistryRow(db, 'route', idOf(added))
    })

    // Assert
    expect(found.label).toBe('In use')
    expect(found.archivedAt).toBeNull()
  })

  test('returns an archived row, because a stored reference to it still has to render', async () => {
    // Arrange / Act: no flag to remember, which is the point of reading by id this way
    const found = await withMigratedScratchDatabase(async (db) => {
      const added = await addRegistryRows(db, 'route', [{ label: 'Retired' }])
      const id = idOf(added)
      await archiveRegistryRow(db, 'route', id)
      return findRegistryRow(db, 'route', id)
    })

    // Assert: the label renders, and the row says it is archived rather than going missing
    expect(found.label).toBe('Retired')
    expect(found.archivedAt).not.toBeNull()
  })

  test('throws NotFoundError for an id that was never there', async () => {
    // Arrange / Act
    const error = await withMigratedScratchDatabase((db) =>
      thrownBy(() => findRegistryRow(db, 'route', 8765)),
    )

    // Assert
    expect(error).toBeInstanceOf(NotFoundError)
  })

  test('keeps the extra columns of a wider registry', async () => {
    // Arrange / Act
    const found = await withMigratedScratchDatabase(async (db) => {
      const added = await addRegistryRows(db, 'phase', [{ key: 'p1', label: 'A phase', isShortlist: true }])
      return findRegistryRow(db, 'phase', idOf(added))
    })

    // Assert
    expect(found.key).toBe('p1')
    expect(found.isShortlist).toBe(true)
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

  test('names a few conflicting candidates as candidates, not as offenders', async () => {
    // Arrange / Act: three keys, one of which already exists
    const error = await withMigratedScratchDatabase(async (db) => {
      await addRegistryRows(db, 'phase', [{ key: 'p1', label: 'A phase' }])
      return thrownBy(() =>
        addRegistryRows(db, 'phase', [
          { key: 'p1', label: 'One' },
          { key: 'p2', label: 'Two' },
          { key: 'p3', label: 'Three' },
        ]),
      )
    })

    // Assert: Postgres reports one violated constraint, so two of the three are innocent
    // and the message may not say otherwise
    expect(error).toBeInstanceOf(ConflictError)
    expect((error as ConflictError).key).toBe('one of: p1, p2, p3')
    // the rendered text is all a user reads on the 409
    expect((error as Error).message).toBe('phase key one of: p1, p2, p3 already exists')
  })

  test('counts the rows rather than listing them when a long bulk call conflicts', async () => {
    // Arrange / Act: more keys than a message should list, the first of which already exists
    const error = await withMigratedScratchDatabase(async (db) => {
      await addRegistryRows(db, 'phase', [{ key: 'p1', label: 'A phase' }])
      const many = Array.from({ length: 6 }, (_, index) => ({
        key: `p${index + 1}`,
        label: `Phase ${index + 1}`,
      }))
      return thrownBy(() => addRegistryRows(db, 'phase', many))
    })

    // Assert: a list of six keys no reader would scan becomes the count
    expect(error).toBeInstanceOf(ConflictError)
    expect((error as ConflictError).key).toBe('in one of the 6 rows this call carried')
    expect((error as Error).message).toBe('phase key in one of the 6 rows this call carried already exists')
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
