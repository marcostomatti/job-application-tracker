import { describe, expect, test } from 'bun:test'
import { count, sql } from 'drizzle-orm'
import type { PgTable } from 'drizzle-orm/pg-core'

import type { DrizzleClient } from '../../src/data/client.ts'
import { upsertCompany } from '../../src/data/repositories/companies.ts'
import {
  addPositions,
  getPosition,
  searchPositions,
  updatePosition,
  type Position,
} from '../../src/data/repositories/positions.ts'
import {
  addRegistryRows,
  archiveRegistryRow,
} from '../../src/data/repositories/registries.ts'
import { writeSummary } from '../../src/data/repositories/summaries.ts'
import { criteriaSet, requirement } from '../../src/data/schema/criteria.ts'
import { positionDisposition, positionStageEvent } from '../../src/data/schema/dispositions.ts'
import { company, position } from '../../src/data/schema/positions.ts'
import { origin } from '../../src/data/schema/provenance.ts'
import { positionPenalty, positionRating, positionScore } from '../../src/data/schema/scores.ts'
import { getBestScores } from '../../src/data/repositories/scores.ts'
import { ArchivedError, BulkItemError, ConflictError, NotFoundError } from '../../src/errors.ts'
import { BULK_MAX, bulkOf } from '../../src/schemas/common.ts'
import {
  CompanyInputSchema,
  PositionInputSchema,
  PositionPatchSchema,
  PositionQuerySchema,
  type PositionInput,
  type PositionPatch,
  type PositionQuery,
} from '../../src/schemas/positions.ts'
import { SummaryInputSchema } from '../../src/schemas/summaries.ts'
import { thrownBy } from '../data/rolled-back.ts'
import { withMigratedScratchDatabase } from '../data/scratch-database.ts'

const ANCHORS = { '0': 'does not meet it', '0.5': 'partly meets it', '1': 'fully meets it' }

/** The id at `index`, or a loud failure: an absent row would otherwise read as a pass. */
function idOf(rows: readonly { readonly id: number }[], index = 0): number {
  const id = rows[index]?.id
  if (id === undefined) throw new Error(`the arrangement produced no row at index ${index}`)
  return id
}

function role(employer: string, title: string, extra: Partial<PositionInput> = {}): PositionInput {
  return { company: { name: employer }, roleTitle: title, ...extra }
}

async function rowCount(db: DrizzleClient, table: PgTable): Promise<number> {
  const [found] = await db.select({ n: count() }).from(table)
  return found?.n ?? 0
}

/** The query a surface would hand over after parsing `{}` plus these filters. */
function queryOf(filters: Record<string, unknown> = {}): PositionQuery {
  return PositionQuerySchema.parse(filters)
}

/** Adds one position and returns the stored row, failing loudly when none came back. */
async function addOne(db: DrizzleClient, input: PositionInput): Promise<Position> {
  const [added] = await addPositions(db, [input])
  if (!added) throw new Error('the arrangement stored no position')
  return added
}

/** How many rows the tie-break tests seed: enough that storage order and id order part ways. */
const TIED_ROWS = 10

/**
 * Writes `TIED_ROWS` stage events that share one instant, as events written in one
 * transaction do, each under its own stage, and returns the id of the stage of the last one,
 * which has the highest event id and so is the latest by the tie-break.
 *
 * A latest-event read asks for one row, so unlike a page it cannot be bound wider to force the
 * ordering. And the index on (position, time, id) hands back the highest id on its own, which
 * would hide a missing `id desc`. So the session is held to a sequential scan, where only the
 * ORDER BY clause decides among ten equal timestamps. Turning the two scan types off cannot
 * make a correct query fail; it only makes a query without the tie-break visible.
 */
async function writeTiedStageEvents(db: DrizzleClient, positionId: number): Promise<number> {
  const stages = await addRegistryRows(
    db,
    'stage',
    Array.from({ length: TIED_ROWS }, (_, index) => ({ key: `tie-${index}`, label: `Tied stage ${index}` })),
  )
  const at = new Date('2026-02-01T09:00:00Z')
  await db.execute(sql`set enable_indexscan = off`)
  await db.execute(sql`set enable_bitmapscan = off`)
  await db.insert(positionStageEvent).values(stages.map((row) => ({ positionId, stageId: row.id, occurredAt: at })))
  return idOf(stages, TIED_ROWS - 1)
}

async function thrownBulk(attempt: () => Promise<unknown>): Promise<BulkItemError> {
  const error = await thrownBy(attempt)
  if (!(error instanceof BulkItemError)) throw new Error(`expected a BulkItemError, got ${String(error)}`)
  return error
}

describe('upsertCompany', () => {
  test('matches two spellings of one employer', async () => {
    // Arrange / Act
    const { first, second, rows } = await withMigratedScratchDatabase(async (db) => ({
      first: await upsertCompany(db, { name: 'Café Ltd' }),
      second: await upsertCompany(db, { name: 'Cafe  LTD.' }),
      rows: await rowCount(db, company),
    }))

    // Assert: one row, and it keeps the spelling it was first seen under
    expect(second.id).toBe(first.id)
    expect(rows).toBe(1)
    expect(second.name).toBe('Café Ltd')
  })

  test('keeps two different non-Latin names apart', async () => {
    // Arrange / Act: a voiced kana and its plain form are different employers
    const { voiced, plain, rows } = await withMigratedScratchDatabase(async (db) => ({
      voiced: await upsertCompany(db, { name: 'バンク' }),
      plain: await upsertCompany(db, { name: 'ハンク' }),
      rows: await rowCount(db, company),
    }))

    // Assert
    expect(voiced.id).not.toBe(plain.id)
    expect(rows).toBe(2)
  })

  test('stores the unresolved flag and does not flip it on a later call by the same name', async () => {
    // Arrange / Act
    const { placeholder, again } = await withMigratedScratchDatabase(async (db) => ({
      placeholder: await upsertCompany(db, { name: 'Partner undisclosed', nameUnresolved: true }),
      again: await upsertCompany(db, { name: 'partner Undisclosed' }),
    }))

    // Assert: the same placeholder, returned as stored
    expect(placeholder.nameUnresolved).toBe(true)
    expect(again.id).toBe(placeholder.id)
    expect(again.nameUnresolved).toBe(true)
  })
})

describe('addPositions', () => {
  test('writes every item in one transaction and shares a company between two spellings', async () => {
    // Arrange / Act
    const { added, companies } = await withMigratedScratchDatabase(async (db) => ({
      added: await addPositions(db, [
        role('Café Ltd', 'Staff Engineer'),
        role('Cafe Ltd', 'Data Engineer'),
        role('Other Co', 'Staff Engineer'),
      ]),
      companies: await rowCount(db, company),
    }))

    // Assert
    expect(added).toHaveLength(3)
    expect(added[0]?.companyId).toBe(added[1]?.companyId as number)
    expect(added[2]?.companyId).not.toBe(added[0]?.companyId as number)
    expect(companies).toBe(2)
    expect(added.map((row) => row.roleNorm)).toEqual(['staff engineer', 'data engineer', 'staff engineer'])
  })

  test('derives a position key and keeps one the caller supplies', async () => {
    // Arrange / Act
    const added = await withMigratedScratchDatabase((db) =>
      addPositions(db, [role('Acme', 'Staff Engineer'), role('Acme', 'Data Engineer', { positionKey: 'acme-data' })]),
    )

    // Assert
    expect(added[0]?.positionKey).toBe('acme/staff engineer')
    expect(added[1]?.positionKey).toBe('acme-data')
  })

  test('returns an empty list for an empty call', async () => {
    // Arrange / Act
    const added = await withMigratedScratchDatabase((db) => addPositions(db, []))

    // Assert
    expect(added).toEqual([])
  })

  test('leaves nothing behind when item 2 of 3 fails, and names index 1', async () => {
    // Arrange / Act: the middle item repeats the first one's company, role and disambiguator
    const { error, positions, companies } = await withMigratedScratchDatabase(async (db) => {
      const error = await thrownBulk(() =>
        addPositions(db, [
          role('Acme', 'Staff Engineer'),
          role('ACME', 'staff  engineer'),
          role('Third Co', 'Anything'),
        ]),
      )
      return { error, positions: await rowCount(db, position), companies: await rowCount(db, company) }
    })

    // Assert: the right item is named, and neither the first item's position nor the
    // company it created survived, nor did the third item run
    expect(error.index).toBe(1)
    expect(error.cause).toBeInstanceOf(ConflictError)
    expect(positions).toBe(0)
    expect(companies).toBe(0)
    // The driver's fault rides on `cause`, and neither message carries the query it failed on
    const conflict = error.cause as ConflictError
    expect(conflict.cause).toBeDefined()
    expect(`${error.message} ${conflict.message}`).not.toMatch(/insert into|select |position_position_key_unique/i)
  })

  test('names the last index when the last item fails', async () => {
    // Arrange / Act
    const { error, positions } = await withMigratedScratchDatabase(async (db) => {
      const error = await thrownBulk(() =>
        addPositions(db, [role('A', 'One'), role('B', 'Two'), role('A', 'one')]),
      )
      return { error, positions: await rowCount(db, position) }
    })

    // Assert
    expect(error.index).toBe(2)
    expect(positions).toBe(0)
  })

  test('keeps rows written before the call when a later call fails', async () => {
    // Arrange / Act: the second call collides with a row the first one committed
    const { error, positions } = await withMigratedScratchDatabase(async (db) => {
      await addOne(db, role('Acme', 'Staff Engineer'))
      const error = await thrownBulk(() =>
        addPositions(db, [role('New Co', 'Fresh'), role('Acme', 'Staff Engineer')]),
      )
      return { error, positions: await rowCount(db, position) }
    })

    // Assert: only the pre-existing row remains
    expect(error.index).toBe(1)
    expect(positions).toBe(1)
  })

  test('reports a repeated position key as a conflict on the item that repeats it', async () => {
    // Arrange / Act: two different roles under one explicit key
    const { error, positions } = await withMigratedScratchDatabase(async (db) => {
      const error = await thrownBulk(() =>
        addPositions(db, [
          role('Acme', 'One', { positionKey: 'shared' }),
          role('Acme', 'Two', { positionKey: 'shared' }),
        ]),
      )
      return { error, positions: await rowCount(db, position) }
    })

    // Assert
    const cause = error.cause as ConflictError
    expect(error.index).toBe(1)
    expect(cause).toBeInstanceOf(ConflictError)
    expect(cause.field).toBe('position_key')
    expect(cause.key).toBe('shared')
    expect(positions).toBe(0)
  })

  test('lets a disambiguator tell two roles with one title apart', async () => {
    // Arrange / Act
    const added = await withMigratedScratchDatabase((db) =>
      addPositions(db, [
        role('Acme', 'Engineer', { disambiguator: 'platform' }),
        role('Acme', 'Engineer', { disambiguator: 'data' }),
      ]),
    )

    // Assert
    expect(added).toHaveLength(2)
  })

  test('refuses an archived work format, names the item, and writes nothing', async () => {
    // Arrange / Act
    const { error, positions } = await withMigratedScratchDatabase(async (db) => {
      const formats = await addRegistryRows(db, 'work_format', [{ label: 'Retired format' }])
      const workFormatId = idOf(formats)
      await archiveRegistryRow(db, 'work_format', workFormatId)
      const error = await thrownBulk(() =>
        addPositions(db, [role('Acme', 'One'), role('Acme', 'Two', { workFormatId })]),
      )
      return { error, positions: await rowCount(db, position) }
    })

    // Assert
    expect(error.index).toBe(1)
    expect(error.cause).toBeInstanceOf(ArchivedError)
    expect(positions).toBe(0)
  })

  test('refuses a seniority and an apply route that do not exist', async () => {
    // Arrange / Act
    const { seniority, route } = await withMigratedScratchDatabase(async (db) => ({
      seniority: await thrownBulk(() => addPositions(db, [role('Acme', 'One', { seniorityId: 9999 })])),
      route: await thrownBulk(() => addPositions(db, [role('Acme', 'One', { applyRouteId: 9999 })])),
    }))

    // Assert
    expect(seniority.cause).toBeInstanceOf(NotFoundError)
    expect(route.cause).toBeInstanceOf(NotFoundError)
  })

  test('stores references to rows that are not archived', async () => {
    // Arrange / Act
    const added = await withMigratedScratchDatabase(async (db) => {
      const seniorityId = idOf(await addRegistryRows(db, 'seniority', [{ label: 'A level', sort: 1 }]))
      const workFormatId = idOf(await addRegistryRows(db, 'work_format', [{ label: 'A format' }]))
      return addOne(db, role('Acme', 'One', { seniorityId, workFormatId }))
    })

    // Assert
    expect(added).toMatchObject({ seniorityId: expect.any(Number), workFormatId: expect.any(Number) })
  })

  test('ignores a hand-ranking and import timestamps that a wider object carries at runtime', async () => {
    // Arrange: a capture path holding more than the type allows; TypeScript lets an extra
    // property ride on a variable, so the rule has to hold at runtime and not only in the schema
    const wider = {
      ...role('Acme', 'One'),
      priorityRank: 5,
      firstImportedAt: new Date('2001-01-01T00:00:00Z'),
      lastImportedAt: new Date('2001-01-01T00:00:00Z'),
      companyId: 999,
    } as PositionInput

    // Act
    const stored = await withMigratedScratchDatabase(async (db) => {
      const created = await addOne(db, wider)
      return { created, read: (await getPosition(db, created.id)).position }
    })

    // Assert: the ranking is empty and both timestamps are the column default, not 2001
    const recently = Date.now() - 60_000
    for (const row of [stored.created, stored.read]) {
      expect(row.priorityRank).toBeNull()
      expect(row.lastImportedAt.getTime()).toBeGreaterThan(recently)
      expect(row.firstImportedAt.getTime()).toBeGreaterThan(recently)
      expect(row.companyId).not.toBe(999)
    }
  })

  test('does not wrap a failure the repository does not recognise', async () => {
    // Arrange / Act: a malformed date, which the schema would have refused, reaches the
    // database; the repository classifies only duplicates and vocabulary refusals as the
    // item's fault and does not guess at the rest
    const error = await withMigratedScratchDatabase((db) =>
      thrownBy(() => addPositions(db, [role('Acme', 'One', { seenAt: 'not a date' })])),
    )

    // Assert: it reaches the caller as it is, rather than as a 400 naming an item
    expect(error).toBeDefined()
    expect(error).not.toBeInstanceOf(BulkItemError)
  })

  test('writes a call of exactly BULK_MAX items', async () => {
    // Arrange: 500 positions across two registries, which is the guard's worst case
    const stored = await withMigratedScratchDatabase(async (db) => {
      const seniorityId = idOf(await addRegistryRows(db, 'seniority', [{ label: 'A level' }]))
      const workFormatId = idOf(await addRegistryRows(db, 'work_format', [{ label: 'A format' }]))
      const items = Array.from({ length: BULK_MAX }, (_, index) =>
        role(`Company ${index % 50}`, `Role ${index}`, { seniorityId, workFormatId }),
      )

      // Act
      await addPositions(db, items)
      return rowCount(db, position)
    })

    // Assert
    expect(stored).toBe(BULK_MAX)
  }, 30_000)
})

describe('the position input schemas', () => {
  const minimal = { company: { name: 'Acme' }, roleTitle: 'Staff Engineer' }

  test('cannot carry a hand-ranking, and no other write schema can either', () => {
    // Assert: strictness is what makes the rule impossible rather than merely unused
    expect(PositionInputSchema.safeParse({ ...minimal, priorityRank: 1 }).success).toBe(false)
    expect(bulkOf(PositionInputSchema).safeParse({ items: [{ ...minimal, priorityRank: 1 }] }).success).toBe(false)
    expect(Object.keys(PositionInputSchema.shape)).not.toContain('priorityRank')
    expect(Object.keys(SummaryInputSchema.shape)).not.toContain('priorityRank')
    expect(Object.keys(CompanyInputSchema.shape)).not.toContain('priorityRank')
    expect(Object.keys(PositionPatchSchema.shape)).toContain('priorityRank')
  })

  test('refuses a field it does not name, so an import cannot set the import timestamps', () => {
    // Assert
    expect(PositionInputSchema.safeParse({ ...minimal, lastImportedAt: '2026-01-01' }).success).toBe(false)
    expect(PositionInputSchema.safeParse({ ...minimal, companyId: 3 }).success).toBe(false)
  })

  test('accepts a call of BULK_MAX items and refuses one more', () => {
    // Arrange
    const bulk = bulkOf(PositionInputSchema)
    const items = (n: number) => Array.from({ length: n }, () => minimal)

    // Assert
    expect(bulk.safeParse({ items: items(BULK_MAX) }).success).toBe(true)
    expect(bulk.safeParse({ items: items(BULK_MAX + 1) }).success).toBe(false)
  })

  test('refuses a NUL character, which Postgres cannot store, before it reaches the driver', () => {
    // Assert: refused as a validation message, so it never becomes a driver error with SQL in it
    expect(PositionInputSchema.safeParse({ ...minimal, roleTitle: 'a\u0000b' }).success).toBe(false)
    expect(PositionInputSchema.safeParse({ ...minimal, company: { name: 'a\u0000b' } }).success).toBe(false)
    expect(PositionInputSchema.safeParse({ ...minimal, disambiguator: 'a\u0000b' }).success).toBe(false)
    expect(PositionInputSchema.safeParse({ ...minimal, city: 'a\u0000b' }).success).toBe(false)
    expect(PositionPatchSchema.safeParse({ applyContact: 'a\u0000b' }).success).toBe(false)
  })

  test('refuses a blank company or role, and a date that is not a day', () => {
    // Assert
    expect(PositionInputSchema.safeParse({ ...minimal, roleTitle: '   ' }).success).toBe(false)
    expect(PositionInputSchema.safeParse({ ...minimal, company: { name: '' } }).success).toBe(false)
    expect(PositionInputSchema.safeParse({ ...minimal, deadline: 'soon' }).success).toBe(false)
  })
})

describe('getPosition', () => {
  test('returns the position, its company and no summary or stage when it has none', async () => {
    // Arrange / Act
    const detail = await withMigratedScratchDatabase(async (db) =>
      getPosition(db, (await addOne(db, role('Acme', 'One'))).id),
    )

    // Assert
    expect(detail.position.roleTitle).toBe('One')
    expect(detail.company.name).toBe('Acme')
    expect(detail.summary).toBeNull()
    expect(detail.latestStage).toBeNull()
    expect(detail.scores).toEqual([])
    expect(detail.dispositions).toEqual([])
    expect(detail.origins).toEqual([])
    expect(detail.references).toEqual({ workFormat: null, seniority: null, applyRoute: null })
  })

  test('raises NotFoundError for an id with no position', async () => {
    // Arrange / Act
    const error = await withMigratedScratchDatabase((db) => thrownBy(() => getPosition(db, 4242)))

    // Assert
    expect(error).toBeInstanceOf(NotFoundError)
  })

  test('returns the summary beside the position', async () => {
    // Arrange / Act
    const detail = await withMigratedScratchDatabase(async (db) => {
      const { id } = await addOne(db, role('Acme', 'One'))
      await writeSummary(db, { positionId: id, condensed: 'The posting, condensed', sourceHash: 'h1' })
      return getPosition(db, id)
    })

    // Assert
    expect(detail.summary?.condensed).toBe('The posting, condensed')
  })

  test('returns the latest stage event, not the first', async () => {
    // Arrange / Act: the later-dated event is written first, so the highest id is not the latest
    const detail = await withMigratedScratchDatabase(async (db) => {
      const { id } = await addOne(db, role('Acme', 'One'))
      const stages = await addRegistryRows(db, 'stage', [
        { key: 's1', label: 'Earlier stage' },
        { key: 's2', label: 'Later stage' },
      ])
      await db.insert(positionStageEvent).values([
        { positionId: id, stageId: idOf(stages, 1), occurredAt: new Date('2026-03-01T10:00:00Z'), note: 'later' },
        { positionId: id, stageId: idOf(stages, 0), occurredAt: new Date('2026-01-01T10:00:00Z'), note: 'earlier' },
      ])
      return getPosition(db, id)
    })

    // Assert
    expect(detail.latestStage?.event.note).toBe('later')
    expect(detail.latestStage?.stage?.label).toBe('Later stage')
  })

  test('breaks a same-timestamp tie by id', async () => {
    // Arrange / Act: ten events share one instant, so only the id can say which is latest
    const { detail, expected } = await withMigratedScratchDatabase(async (db) => {
      const { id } = await addOne(db, role('Acme', 'One'))
      const expected = await writeTiedStageEvents(db, id)
      return { detail: await getPosition(db, id), expected }
    })

    // Assert: the highest id wins. Without the tie-break the single row asked for is whichever
    // the scan meets first, which is the lowest id, so this fails for a structural reason.
    expect(detail.latestStage?.stage?.id).toBe(expected)
    expect(detail.latestStage?.stage?.label).toBe(`Tied stage ${TIED_ROWS - 1}`)
  })

  test('renders the stage, phase and references that were archived after they were stored', async () => {
    // Arrange / Act
    const detail = await withMigratedScratchDatabase(async (db) => {
      const phaseId = idOf(await addRegistryRows(db, 'phase', [{ key: 'p1', label: 'A phase' }]))
      const stageId = idOf(
        await addRegistryRows(db, 'stage', [{ key: 's1', label: 'A stage', phaseId, isApplied: true }]),
      )
      const workFormatId = idOf(await addRegistryRows(db, 'work_format', [{ label: 'A format' }]))
      const seniorityId = idOf(await addRegistryRows(db, 'seniority', [{ label: 'A level' }]))
      const { id } = await addOne(db, role('Acme', 'One', { workFormatId, seniorityId }))
      await db.insert(positionStageEvent).values({ positionId: id, stageId })
      const reasonId = idOf(await addRegistryRows(db, 'set_aside_reason', [{ label: 'A reason' }]))
      await db.insert(positionDisposition).values({ positionId: id, kind: 'set_aside', setAsideReasonId: reasonId })
      await archiveRegistryRow(db, 'stage', stageId)
      await archiveRegistryRow(db, 'phase', phaseId)
      await archiveRegistryRow(db, 'work_format', workFormatId)
      await archiveRegistryRow(db, 'seniority', seniorityId)
      await archiveRegistryRow(db, 'set_aside_reason', reasonId)
      return getPosition(db, id)
    })

    // Assert: archival hides a row from a pick-list, never from a reference that names it
    expect(detail.latestStage?.stage?.label).toBe('A stage')
    expect(detail.latestStage?.stage?.isApplied).toBe(true)
    expect(detail.latestStage?.phase?.label).toBe('A phase')
    expect(detail.references.workFormat?.label).toBe('A format')
    expect(detail.references.seniority?.label).toBe('A level')
    expect(detail.dispositions[0]?.reasonLabel).toBe('A reason')
  })

  test('returns the latest score per criteria set, each with its ratings and penalties', async () => {
    // Arrange / Act
    const detail = await withMigratedScratchDatabase(async (db) => {
      const { id } = await addOne(db, role('Acme', 'One'))
      const [setA, setB] = await db
        .insert(criteriaSet)
        .values([
          { name: 'set-a', version: 1 },
          { name: 'set-b', version: 1 },
        ])
        .returning()
      const [reqA] = await db
        .insert(requirement)
        .values({ criteriaSetId: idOf([setA as { id: number }]), key: 'k', label: 'Req A', anchors: ANCHORS })
        .returning()
      const kindId = idOf(await addRegistryRows(db, 'penalty_kind', [{ label: 'A penalty kind' }]))
      const setAId = idOf([setA as { id: number }])
      const setBId = idOf([setB as { id: number }])
      const scores = await db
        .insert(positionScore)
        .values([
          { positionId: id, criteriaSetId: setAId, scoredAt: '2026-01-01', overall: 0.2 },
          { positionId: id, criteriaSetId: setAId, scoredAt: '2026-02-01', overall: 0.8, isRescore: true },
          { positionId: id, criteriaSetId: setBId, scoredAt: '2026-01-15', overall: 0.5 },
        ])
        .returning()
      const latestA = scores[1] as { id: number }
      await db.insert(positionRating).values({
        scoreId: latestA.id,
        criteriaSetId: setAId,
        requirementId: idOf([reqA as { id: number }]),
        coverage: 1,
        confidence: 'supported',
      })
      await db.insert(positionPenalty).values({ scoreId: latestA.id, penaltyKindId: kindId, amount: -0.1 })
      await archiveRegistryRow(db, 'penalty_kind', kindId)
      return { detail: await getPosition(db, id), setAId, setBId }
    })

    // Assert: two sets, so two scores, and set A's is the newer one
    const { detail: found, setAId, setBId } = detail
    expect(found.scores).toHaveLength(2)
    const forA = found.scores.find((entry) => entry.score.criteriaSetId === setAId)
    const forB = found.scores.find((entry) => entry.score.criteriaSetId === setBId)
    expect(forA?.score.overall).toBe(0.8)
    expect(forB?.score.overall).toBe(0.5)
    expect(forA?.ratings.map((rating) => rating.requirementLabel)).toEqual(['Req A'])
    expect(forA?.ratings[0]?.rating.confidence).toBe('supported')
    expect(forA?.penalties.map((penalty) => [penalty.kindLabel, penalty.penalty.amount])).toEqual([
      ['A penalty kind', -0.1],
    ])
    expect(forB?.ratings).toEqual([])
  })

  test('returns dispositions and origins with the labels of the rows they name', async () => {
    // Arrange / Act
    const detail = await withMigratedScratchDatabase(async (db) => {
      const { id } = await addOne(db, role('Acme', 'One'))
      const reasonId = idOf(await addRegistryRows(db, 'set_aside_reason', [{ label: 'Too far' }]))
      const rejectionId = idOf(await addRegistryRows(db, 'rejection_reason', [{ label: 'No reply' }]))
      const routeId = idOf(await addRegistryRows(db, 'route', [{ label: 'A search' }]))
      await db.insert(positionDisposition).values([
        { positionId: id, kind: 'set_aside', setAsideReasonId: reasonId, notedAt: new Date('2026-01-01T00:00:00Z') },
        { positionId: id, kind: 'rejected', rejectionReasonId: rejectionId, notedAt: new Date('2026-02-01T00:00:00Z') },
      ])
      await db.insert(origin).values([
        { positionId: id, routeId, touchedOn: '2026-01-05', note: 'a' },
        { positionId: id, touchedOn: '2026-01-02', note: 'b' },
      ])
      await archiveRegistryRow(db, 'route', routeId)
      return getPosition(db, id)
    })

    // Assert: oldest first, labels kept after archival, and a null route stays null
    expect(detail.dispositions.map((entry) => [entry.disposition.kind, entry.reasonLabel])).toEqual([
      ['set_aside', 'Too far'],
      ['rejected', 'No reply'],
    ])
    expect(detail.origins.map((entry) => [entry.origin.note, entry.routeLabel])).toEqual([
      ['b', null],
      ['a', 'A search'],
    ])
  })
})

describe('searchPositions', () => {
  test('returns an empty list when nothing matches', async () => {
    // Arrange / Act
    const rows = await withMigratedScratchDatabase((db) => searchPositions(db, queryOf()))

    // Assert
    expect(rows).toEqual([])
  })

  test('hides a set-aside position by default and returns it when the filter asks for it', async () => {
    // Arrange / Act
    const { byDefault, included, only } = await withMigratedScratchDatabase(async (db) => {
      const [, passed] = await addPositions(db, [role('Acme', 'Kept'), role('Acme', 'Passed on')])
      const reasonId = idOf(await addRegistryRows(db, 'set_aside_reason', [{ label: 'Too far' }]))
      await db
        .insert(positionDisposition)
        .values({ positionId: idOf([passed as { id: number }]), kind: 'set_aside', setAsideReasonId: reasonId })
      return {
        byDefault: await searchPositions(db, queryOf()),
        included: await searchPositions(db, queryOf({ setAside: 'include' })),
        only: await searchPositions(db, queryOf({ setAside: 'only' })),
      }
    })

    // Assert
    expect(byDefault.map((row) => row.position.roleTitle)).toEqual(['Kept'])
    expect(included.map((row) => row.position.roleTitle).sort()).toEqual(['Kept', 'Passed on'])
    expect(only.map((row) => row.position.roleTitle)).toEqual(['Passed on'])
    expect(included.find((row) => row.position.roleTitle === 'Passed on')?.setAside).toBe(true)
    expect(included.find((row) => row.position.roleTitle === 'Kept')?.setAside).toBe(false)
  })

  test('does not count a rejection as a set-aside', async () => {
    // Arrange / Act
    const rows = await withMigratedScratchDatabase(async (db) => {
      const { id } = await addOne(db, role('Acme', 'Rejected'))
      const reasonId = idOf(await addRegistryRows(db, 'rejection_reason', [{ label: 'No reply' }]))
      await db.insert(positionDisposition).values({ positionId: id, kind: 'rejected', rejectionReasonId: reasonId })
      return searchPositions(db, queryOf())
    })

    // Assert
    expect(rows.map((row) => row.position.roleTitle)).toEqual(['Rejected'])
  })

  test('filters by company', async () => {
    // Arrange / Act
    const { rows, wanted } = await withMigratedScratchDatabase(async (db) => {
      const added = await addPositions(db, [role('Acme', 'One'), role('Other', 'Two'), role('Acme', 'Three')])
      const wanted = (added[0] as Position).companyId
      return { rows: await searchPositions(db, queryOf({ companyId: wanted })), wanted }
    })

    // Assert
    expect(rows.map((row) => row.position.roleTitle).sort()).toEqual(['One', 'Three'])
    expect(rows.every((row) => row.company.id === wanted)).toBe(true)
    expect(rows[0]?.company.name).toBe('Acme')
  })

  test('filters by the phase of the latest stage event, so a position that moved on leaves the old phase', async () => {
    // Arrange / Act
    const { inFirst, inSecond, row } = await withMigratedScratchDatabase(async (db) => {
      const phases = await addRegistryRows(db, 'phase', [
        { key: 'p1', label: 'First phase' },
        { key: 'p2', label: 'Second phase' },
      ])
      const stages = await addRegistryRows(db, 'stage', [
        { key: 's1', label: 'In first', phaseId: idOf(phases, 0) },
        { key: 's2', label: 'In second', phaseId: idOf(phases, 1) },
      ])
      const { id } = await addOne(db, role('Acme', 'Mover'))
      await db.insert(positionStageEvent).values([
        { positionId: id, stageId: idOf(stages, 0), occurredAt: new Date('2026-01-01T00:00:00Z') },
        { positionId: id, stageId: idOf(stages, 1), occurredAt: new Date('2026-02-01T00:00:00Z') },
      ])
      const inSecond = await searchPositions(db, queryOf({ phaseId: idOf(phases, 1) }))
      return {
        inFirst: await searchPositions(db, queryOf({ phaseId: idOf(phases, 0) })),
        inSecond,
        row: inSecond[0],
      }
    })

    // Assert
    expect(inFirst).toEqual([])
    expect(inSecond).toHaveLength(1)
    expect(row?.stage?.label).toBe('In second')
    expect(row?.phase?.label).toBe('Second phase')
  })

  test('shows the same latest stage as getPosition when two events share a timestamp', async () => {
    // Arrange / Act
    const { row, detail } = await withMigratedScratchDatabase(async (db) => {
      const { id } = await addOne(db, role('Acme', 'One'))
      await writeTiedStageEvents(db, id)
      const [row] = await searchPositions(db, queryOf())
      return { row, detail: await getPosition(db, id) }
    })

    // Assert: the board and the modal must not disagree about where a card sits
    expect(row?.stage?.id).toBe(detail.latestStage?.stage?.id as number)
    expect(row?.stage?.label).toBe(`Tied stage ${TIED_ROWS - 1}`)
  })

  test('still renders the stage and phase labels after both were archived', async () => {
    // Arrange / Act
    const rows = await withMigratedScratchDatabase(async (db) => {
      const phaseId = idOf(await addRegistryRows(db, 'phase', [{ key: 'p1', label: 'A phase' }]))
      const stageId = idOf(await addRegistryRows(db, 'stage', [{ key: 's1', label: 'A stage', phaseId }]))
      const { id } = await addOne(db, role('Acme', 'One'))
      await db.insert(positionStageEvent).values({ positionId: id, stageId })
      await archiveRegistryRow(db, 'stage', stageId)
      await archiveRegistryRow(db, 'phase', phaseId)
      return searchPositions(db, queryOf())
    })

    // Assert: archival hides a row from a pick-list, never from a card that sits in it
    expect(rows[0]?.stage?.label).toBe('A stage')
    expect(rows[0]?.phase?.label).toBe('A phase')
  })

  test('shows one score per set name, the newest version\'s, as getBestScores does', async () => {
    // Arrange / Act
    const { detail, best } = await withMigratedScratchDatabase(async (db) => {
      const { id } = await addOne(db, role('Acme', 'One'))
      const created = await db
        .insert(criteriaSet)
        .values([
          { name: 'web-search', version: 1 },
          { name: 'web-search', version: 2 },
          { name: 'other', version: 1 },
        ])
        .returning()
      await db.insert(positionScore).values([
        { positionId: id, criteriaSetId: idOf(created, 0), scoredAt: '2026-01-01', overall: 0.9, recommendApply: true },
        { positionId: id, criteriaSetId: idOf(created, 1), scoredAt: '2026-02-01', overall: 0.2 },
        { positionId: id, criteriaSetId: idOf(created, 2), scoredAt: '2026-02-01', overall: 0.4 },
      ])
      return { detail: await getPosition(db, id), best: await getBestScores(db, id) }
    })

    // Assert: the modal and the "+n" chip count the same lenses
    expect(detail.scores.map((entry) => entry.score.id).sort()).toEqual(best.map((row) => row.id).sort())
    expect(detail.scores).toHaveLength(2)
    expect(detail.scores.map((entry) => entry.score.overall).sort()).toEqual([0.2, 0.4])
  })

  test('shows the same latest score per criteria set as getPosition', async () => {
    // Arrange / Act: scores written newest first, so id order and date order disagree
    const { setAId, setBId, detail, forA, forB } = await withMigratedScratchDatabase(async (db) => {
      const { id } = await addOne(db, role('Acme', 'One'))
      const sets = await db
        .insert(criteriaSet)
        .values([
          { name: 'set-a', version: 1 },
          { name: 'set-b', version: 1 },
        ])
        .returning()
      const setAId = idOf(sets, 0)
      const setBId = idOf(sets, 1)
      await db.insert(positionScore).values([
        { positionId: id, criteriaSetId: setAId, scoredAt: '2026-03-01', overall: 0.9 },
        { positionId: id, criteriaSetId: setAId, scoredAt: '2026-01-01', overall: 0.1 },
        { positionId: id, criteriaSetId: setAId, scoredAt: '2026-02-01', overall: 0.5 },
        { positionId: id, criteriaSetId: setBId, scoredAt: '2026-02-15', overall: 0.7 },
        { positionId: id, criteriaSetId: setBId, scoredAt: '2026-01-15', overall: 0.2 },
      ])
      return {
        setAId,
        setBId,
        detail: await getPosition(db, id),
        forA: await searchPositions(db, queryOf({ criteriaSetId: setAId })),
        forB: await searchPositions(db, queryOf({ criteriaSetId: setBId })),
      }
    })

    // Assert: the board's score and the modal's score are the same row for each set
    const modal = (setId: number) => detail.scores.find((entry) => entry.score.criteriaSetId === setId)?.score
    expect(forA[0]?.score?.id).toBe(modal(setAId)?.id as number)
    expect(forB[0]?.score?.id).toBe(modal(setBId)?.id as number)
    expect(forA[0]?.score?.overall).toBe(0.9)
    expect(forB[0]?.score?.overall).toBe(0.7)
  })

  test('filters on recommend-apply against the set asked for, using that set\'s latest score', async () => {
    // Arrange / Act
    const { yes, no, none, row } = await withMigratedScratchDatabase(async (db) => {
      const [recommended, declined] = await addPositions(db, [
        role('Acme', 'Recommended'),
        role('Acme', 'Declined'),
        role('Acme', 'Unscored'),
      ])
      const [set] = await db.insert(criteriaSet).values({ name: 'set', version: 1 }).returning()
      const setId = idOf([set as { id: number }])
      await db.insert(positionScore).values([
        // An old recommendation that a later score withdrew must not count
        { positionId: idOf([recommended as { id: number }]), criteriaSetId: setId, scoredAt: '2026-01-01', overall: 0.4, recommendApply: false },
        { positionId: idOf([recommended as { id: number }]), criteriaSetId: setId, scoredAt: '2026-02-01', overall: 0.9, recommendApply: true },
        { positionId: idOf([declined as { id: number }]), criteriaSetId: setId, scoredAt: '2026-01-01', overall: 0.1, recommendApply: false },
      ])
      const yes = await searchPositions(db, queryOf({ criteriaSetId: setId, recommendApply: true }))
      return {
        yes,
        no: await searchPositions(db, queryOf({ criteriaSetId: setId, recommendApply: false })),
        none: await searchPositions(db, queryOf({ criteriaSetId: setId })),
        row: yes[0],
      }
    })

    // Assert: an unscored position matches neither answer, and a row carries its score
    expect(yes.map((r) => r.position.roleTitle)).toEqual(['Recommended'])
    expect(no.map((r) => r.position.roleTitle)).toEqual(['Declined'])
    expect(none).toHaveLength(3)
    expect(row?.score).toMatchObject({ overall: 0.9, recommendApply: true })
    expect(none.find((r) => r.position.roleTitle === 'Unscored')?.score).toBeNull()
  })

  describe('the recommend-apply filter without a set named (the across-sets rule)', () => {
    /** An id a destructured array handed back, or a loud failure: an absent one would read as a pass. */
    function need(id: number | undefined): number {
      if (id === undefined) throw new Error('the arrangement produced fewer sets than the test names')
      return id
    }

    async function sets(db: DrizzleClient, values: { name: string; version: number; isDefault?: boolean; archived?: boolean }[]): Promise<number[]> {
      const rows = await db
        .insert(criteriaSet)
        .values(values.map((v) => ({ name: v.name, version: v.version, isDefault: v.isDefault ?? false, archivedAt: v.archived ? new Date() : null })))
        .returning()
      return rows.map((_, index) => idOf(rows, index))
    }

    function score(positionId: number, setId: number, recommendApply: boolean, scoredAt = '2026-02-01'): typeof positionScore.$inferInsert {
      return { positionId, criteriaSetId: setId, scoredAt, overall: recommendApply ? 0.9 : 0.1, recommendApply }
    }

    const titles = (rows: { position: { roleTitle: string } }[]): string[] => rows.map((row) => row.position.roleTitle).sort()

    test('lists a position that only a set other than the default recommends', async () => {
      // Arrange / Act: the default set declines it, a second set recommends it
      const { yes, no } = await withMigratedScratchDatabase(async (db) => {
        const { id } = await addOne(db, role('Acme', 'Only B'))
        const [defaultId, otherId] = await sets(db, [
          { name: 'standard', version: 1, isDefault: true },
          { name: 'other', version: 1 },
        ])
        await db.insert(positionScore).values([
          score(id, need(defaultId), false),
          score(id, need(otherId), true),
        ])
        return {
          yes: await searchPositions(db, queryOf({ recommendApply: true })),
          no: await searchPositions(db, queryOf({ recommendApply: false })),
        }
      })

      // Assert: recommended by one live set is recommended, so it is not in the declined answer
      expect(titles(yes)).toEqual(['Only B'])
      expect(no).toEqual([])
    })

    test('does not list a position that only a superseded version recommends', async () => {
      // Arrange / Act: v1 recommends it; v2 of the same name scored it and declined, and a second position was never scored under v2
      const { yes, no } = await withMigratedScratchDatabase(async (db) => {
        const [declined, unscored] = await addPositions(db, [role('Acme', 'Declined by v2'), role('Acme', 'Not yet under v2')])
        const [v1, v2] = await sets(db, [
          { name: 'web-search', version: 1 },
          { name: 'web-search', version: 2, isDefault: true },
        ])
        const v1Id = need(v1)
        const v2Id = need(v2)
        const declinedId = idOf([declined as { id: number }])
        const unscoredId = idOf([unscored as { id: number }])
        await db.insert(positionScore).values([
          score(declinedId, v1Id, true, '2026-01-01'),
          score(declinedId, v2Id, false, '2026-02-01'),
          score(unscoredId, v1Id, true, '2026-01-01'),
        ])
        return {
          yes: await searchPositions(db, queryOf({ recommendApply: true })),
          no: await searchPositions(db, queryOf({ recommendApply: false })),
        }
      })

      // Assert: v1's old yes does not count, and a position v2 has not scored matches neither answer
      expect(yes).toEqual([])
      expect(titles(no)).toEqual(['Declined by v2'])
    })

    test('shows the score that caused the match, not the default set\'s denial', async () => {
      // Arrange / Act: the default set declines the position; another set recommends it
      const { yes, no, unfiltered, otherId } = await withMigratedScratchDatabase(async (db) => {
        const { id } = await addOne(db, role('Acme', 'Only B'))
        const [defaultId, otherId] = await sets(db, [
          { name: 'standard', version: 1, isDefault: true },
          { name: 'other', version: 1 },
        ])
        await db.insert(positionScore).values([score(id, need(defaultId), false), score(id, need(otherId), true)])
        return {
          otherId: need(otherId),
          yes: await searchPositions(db, queryOf({ recommendApply: true })),
          no: await searchPositions(db, queryOf({ recommendApply: false })),
          unfiltered: await searchPositions(db, queryOf()),
        }
      })

      // Assert: the filtered row carries the recommending set's score; with no answer asked the default set's score stays
      expect(yes[0]?.score).toMatchObject({ criteriaSetId: otherId, recommendApply: true })
      expect(no).toEqual([])
      expect(unfiltered[0]?.score).toMatchObject({ recommendApply: false })
    })

    test('shows the best-scoring of several recommending sets, ties going to the later score', async () => {
      // Arrange / Act
      const { rows, highId, lateId } = await withMigratedScratchDatabase(async (db) => {
        const [high, tied] = await addPositions(db, [role('Acme', 'High'), role('Acme', 'Tied')])
        const [a, b, c] = await sets(db, [
          { name: 'a', version: 1, isDefault: true },
          { name: 'b', version: 1 },
          { name: 'c', version: 1 },
        ])
        const highPosition = idOf([high as { id: number }])
        const tiedPosition = idOf([tied as { id: number }])
        await db.insert(positionScore).values([
          { ...score(highPosition, need(a), true), overall: 0.6 },
          { ...score(highPosition, need(b), true), overall: 0.95 },
          { ...score(highPosition, need(c), false), overall: 0.99 },
          { ...score(tiedPosition, need(a), true, '2026-01-01'), overall: 0.8 },
          { ...score(tiedPosition, need(b), true, '2026-03-01'), overall: 0.8 },
        ])
        return { rows: await searchPositions(db, queryOf({ recommendApply: true })), highId: need(b), lateId: need(b) }
      })

      // Assert: a declining set never supplies the score, even with the highest overall
      const byTitle = (title: string) => rows.find((row) => row.position.roleTitle === title)?.score
      expect(byTitle('High')).toMatchObject({ criteriaSetId: highId, overall: 0.95 })
      expect(byTitle('Tied')).toMatchObject({ criteriaSetId: lateId, scoredAt: '2026-03-01' })
    })

    test('shows a declining score for the declined answer', async () => {
      // Arrange / Act
      const no = await withMigratedScratchDatabase(async (db) => {
        const { id } = await addOne(db, role('Acme', 'Declined'))
        const [a, b] = await sets(db, [
          { name: 'a', version: 1, isDefault: true },
          { name: 'b', version: 1 },
        ])
        await db.insert(positionScore).values([{ ...score(id, need(a), false), overall: 0.2 }, { ...score(id, need(b), false), overall: 0.4 }])
        return searchPositions(db, queryOf({ recommendApply: false }))
      })

      // Assert: the declined row is not left without a score, and shows its best declining one
      expect(no[0]?.score).toMatchObject({ recommendApply: false, overall: 0.4 })
    })

    test('lists a position recommended by a higher version whatever an older version says', async () => {
      // Arrange / Act
      const yes = await withMigratedScratchDatabase(async (db) => {
        const { id } = await addOne(db, role('Acme', 'Lifted by v2'))
        const [v1, v2] = await sets(db, [
          { name: 'web-search', version: 1 },
          { name: 'web-search', version: 2 },
        ])
        await db.insert(positionScore).values([
          score(id, need(v1), false, '2026-01-01'),
          score(id, need(v2), true, '2026-02-01'),
        ])
        return searchPositions(db, queryOf({ recommendApply: true }))
      })

      // Assert
      expect(titles(yes)).toEqual(['Lifted by v2'])
    })

    test('reads only the latest score of each set, so a withdrawn recommendation does not count', async () => {
      // Arrange / Act
      const { yes, no } = await withMigratedScratchDatabase(async (db) => {
        const { id } = await addOne(db, role('Acme', 'Withdrawn'))
        const [setId] = await sets(db, [{ name: 'only', version: 1 }])
        const only = need(setId)
        await db.insert(positionScore).values([score(id, only, true, '2026-01-01'), score(id, only, false, '2026-02-01')])
        return {
          yes: await searchPositions(db, queryOf({ recommendApply: true })),
          no: await searchPositions(db, queryOf({ recommendApply: false })),
        }
      })

      // Assert
      expect(yes).toEqual([])
      expect(titles(no)).toEqual(['Withdrawn'])
    })

    test('still answers for the set a caller names, superseded or not', async () => {
      // Arrange / Act
      const { forV1, forV2, unfiltered } = await withMigratedScratchDatabase(async (db) => {
        const { id } = await addOne(db, role('Acme', 'Named'))
        const [v1, v2] = await sets(db, [
          { name: 'web-search', version: 1 },
          { name: 'web-search', version: 2 },
        ])
        const v1Id = need(v1)
        const v2Id = need(v2)
        await db.insert(positionScore).values([score(id, v1Id, true, '2026-01-01'), score(id, v2Id, false, '2026-02-01')])
        return {
          forV1: await searchPositions(db, queryOf({ criteriaSetId: v1Id, recommendApply: true })),
          forV2: await searchPositions(db, queryOf({ criteriaSetId: v2Id, recommendApply: true })),
          unfiltered: await searchPositions(db, queryOf({ recommendApply: true })),
        }
      })

      // Assert: naming v1 narrows to v1's own answer; the unnamed rule does not use it
      expect(titles(forV1)).toEqual(['Named'])
      expect(forV2).toEqual([])
      expect(unfiltered).toEqual([])
    })

    test('lets an archived set that is the newest version of its name still recommend', async () => {
      // Arrange / Act: archival retires a set from new use, and a stored recommendation is not a new use
      const yes = await withMigratedScratchDatabase(async (db) => {
        const { id } = await addOne(db, role('Acme', 'Archived lens'))
        const [setId] = await sets(db, [{ name: 'retired', version: 1, archived: true }])
        await db.insert(positionScore).values(score(id, need(setId), true))
        return searchPositions(db, queryOf({ recommendApply: true }))
      })

      // Assert
      expect(titles(yes)).toEqual(['Archived lens'])
    })

    test('gives a position with no score under any set neither answer', async () => {
      // Arrange / Act
      const { yes, no, all } = await withMigratedScratchDatabase(async (db) => {
        await addOne(db, role('Acme', 'Unscored'))
        await sets(db, [{ name: 'standard', version: 1, isDefault: true }])
        return {
          yes: await searchPositions(db, queryOf({ recommendApply: true })),
          no: await searchPositions(db, queryOf({ recommendApply: false })),
          all: await searchPositions(db, queryOf()),
        }
      })

      // Assert
      expect([yes, no]).toEqual([[], []])
      expect(all).toHaveLength(1)
    })
  })

  test('reads scores from the default set when no set is named', async () => {
    // Arrange / Act
    const rows = await withMigratedScratchDatabase(async (db) => {
      const { id } = await addOne(db, role('Acme', 'One'))
      const [other, standard] = await db
        .insert(criteriaSet)
        .values([
          { name: 'other', version: 1 },
          { name: 'standard', version: 1, isDefault: true },
        ])
        .returning()
      await db.insert(positionScore).values([
        { positionId: id, criteriaSetId: idOf([other as { id: number }]), overall: 0.3, recommendApply: false },
        { positionId: id, criteriaSetId: idOf([standard as { id: number }]), overall: 0.7, recommendApply: true },
      ])
      return searchPositions(db, queryOf({ recommendApply: true }))
    })

    // Assert
    expect(rows).toHaveLength(1)
    expect(rows[0]?.score?.overall).toBe(0.7)
  })

  test('pages in a stable order, newest first', async () => {
    // Arrange / Act
    const { first, second, third } = await withMigratedScratchDatabase(async (db) => {
      await addPositions(db, [
        role('Acme', 'A', { seenAt: '2026-01-01' }),
        role('Acme', 'B', { seenAt: '2026-03-01' }),
        role('Acme', 'C', { seenAt: '2026-03-01' }),
        role('Acme', 'D', { seenAt: '2026-02-01' }),
      ])
      return {
        first: await searchPositions(db, queryOf({ limit: 2, offset: 0 })),
        second: await searchPositions(db, queryOf({ limit: 2, offset: 2 })),
        third: await searchPositions(db, queryOf({ limit: 2, offset: 4 })),
      }
    })

    // Assert: the same day falls back to the later id, and the pages tile without overlap
    const titles = (rows: typeof first) => rows.map((row) => row.position.roleTitle)
    expect(titles(first)).toEqual(['C', 'B'])
    expect(titles(second)).toEqual(['D', 'A'])
    expect(third).toEqual([])
  })

  test('takes the highest ids when many positions share a sort key and a page is bound', async () => {
    // Arrange / Act: ten positions seen on one day, ids ascending in the order written
    const { written, firstPage, secondPage } = await withMigratedScratchDatabase(async (db) => {
      const written = await addPositions(
        db,
        Array.from({ length: TIED_ROWS }, (_, index) => role('Acme', `Role ${index}`, { seenAt: '2026-03-01' })),
      )
      return {
        written,
        firstPage: await searchPositions(db, queryOf({ limit: 3 })),
        secondPage: await searchPositions(db, queryOf({ limit: 3, offset: 3 })),
      }
    })

    // Assert: with identical dates only the id orders them, so a page of three is forced to
    // be the three highest ids; without the tie-break it is the first three the scan meets,
    // which are the lowest. The next page continues downwards with no gap and no overlap.
    const ids = written.map((row) => row.id)
    expect(firstPage.map((row) => row.position.id)).toEqual(ids.slice(-3).reverse())
    expect(secondPage.map((row) => row.position.id)).toEqual(ids.slice(-6, -3).reverse())
  })

  test('hides a client-hidden position by default, and returns it when asked', async () => {
    // Arrange / Act
    const { byDefault, included, only } = await withMigratedScratchDatabase(async (db) => {
      await addPositions(db, [role('Acme', 'Shown'), role('Acme', 'Hidden', { clientHidden: true })])
      return {
        byDefault: await searchPositions(db, queryOf()),
        included: await searchPositions(db, queryOf({ clientHidden: 'include' })),
        only: await searchPositions(db, queryOf({ clientHidden: 'only' })),
      }
    })

    // Assert
    expect(byDefault.map((row) => row.position.roleTitle)).toEqual(['Shown'])
    expect(included.map((row) => row.position.roleTitle).sort()).toEqual(['Hidden', 'Shown'])
    expect(only.map((row) => row.position.roleTitle)).toEqual(['Hidden'])
  })

  test('applies the set-aside and client-hidden filters independently', async () => {
    // Arrange / Act: one position that is both, which each filter must be able to bring back alone
    const { neither, setAsideOnly, hiddenOnly, both } = await withMigratedScratchDatabase(async (db) => {
      const { id } = await addOne(db, role('Acme', 'Both', { clientHidden: true }))
      const reasonId = idOf(await addRegistryRows(db, 'set_aside_reason', [{ label: 'Too far' }]))
      await db.insert(positionDisposition).values({ positionId: id, kind: 'set_aside', setAsideReasonId: reasonId })
      return {
        neither: await searchPositions(db, queryOf()),
        setAsideOnly: await searchPositions(db, queryOf({ setAside: 'include' })),
        hiddenOnly: await searchPositions(db, queryOf({ clientHidden: 'include' })),
        both: await searchPositions(db, queryOf({ setAside: 'include', clientHidden: 'include' })),
      }
    })

    // Assert: it takes both flags to hide it by default, and both opt-ins to see it
    expect(neither).toEqual([])
    expect(setAsideOnly).toEqual([])
    expect(hiddenOnly).toEqual([])
    expect(both).toHaveLength(1)
  })
})

describe('the position query schema', () => {
  test('composes the filters with pagination, so a filter does not trip the strict page schema', () => {
    // Act: a query string carries every value as text
    const parsed = PositionQuerySchema.parse({ companyId: '3', limit: '10', setAside: 'only' })

    // Assert
    expect(parsed).toMatchObject({ companyId: 3, limit: 10, offset: 0, setAside: 'only' })
  })

  test('still refuses a key it does not name', () => {
    // Assert
    expect(PositionQuerySchema.safeParse({ company: 3 }).success).toBe(false)
    expect(PositionQuerySchema.safeParse({ setAside: 'maybe' }).success).toBe(false)
  })

  test('defaults to hiding set-aside and client-hidden positions', () => {
    // Assert
    expect(PositionQuerySchema.parse({}).setAside).toBe('exclude')
    expect(PositionQuerySchema.parse({}).clientHidden).toBe('exclude')
    expect(PositionQuerySchema.safeParse({ clientHidden: 'maybe' }).success).toBe(false)
  })
})

describe('updatePosition', () => {
  test('returns a new object and does not mutate its input', async () => {
    // Arrange / Act
    const { before, patch, updated } = await withMigratedScratchDatabase(async (db) => {
      const stored = await addOne(db, role('Acme', 'One', { city: 'Lisbon' }))
      const before = await getPosition(db, stored.id)
      const patch = Object.freeze({ city: 'Porto', priorityRank: 2 })
      return { before: before.position, patch, updated: await updatePosition(db, stored.id, patch) }
    })

    // Assert: a frozen patch would throw on mutation, and the row read before is unchanged
    expect(updated.city).toBe('Porto')
    expect(before.city).toBe('Lisbon')
    expect(patch).toEqual({ city: 'Porto', priorityRank: 2 })
    expect(updated.roleTitle).toBe('One')
  })

  test('accepts the hand-ranking, and clears it with null', async () => {
    // Arrange / Act
    const { ranked, cleared } = await withMigratedScratchDatabase(async (db) => {
      const { id } = await addOne(db, role('Acme', 'One'))
      return {
        ranked: await updatePosition(db, id, { priorityRank: 3 }),
        cleared: await updatePosition(db, id, { priorityRank: null }),
      }
    })

    // Assert
    expect(ranked.priorityRank).toBe(3)
    expect(cleared.priorityRank).toBeNull()
  })

  test('recomputes the role key when the title changes', async () => {
    // Arrange / Act
    const updated = await withMigratedScratchDatabase(async (db) => {
      const { id } = await addOne(db, role('Acme', 'One'))
      return updatePosition(db, id, { roleTitle: 'Café Lead' })
    })

    // Assert
    expect(updated.roleTitle).toBe('Café Lead')
    expect(updated.roleNorm).toBe('cafe lead')
  })

  test('reports a title that now collides with another position as a conflict', async () => {
    // Arrange / Act
    const { error, unchanged } = await withMigratedScratchDatabase(async (db) => {
      await addOne(db, role('Acme', 'One'))
      const { id } = await addOne(db, role('Acme', 'Two'))
      const error = await thrownBy(() => updatePosition(db, id, { roleTitle: 'one' }))
      return { error, unchanged: (await getPosition(db, id)).position.roleTitle }
    })

    // Assert
    expect(error).toBeInstanceOf(ConflictError)
    expect(unchanged).toBe('Two')
  })

  test('refuses an archived seniority and leaves the row as it was', async () => {
    // Arrange / Act
    const { error, stored } = await withMigratedScratchDatabase(async (db) => {
      const seniorityId = idOf(await addRegistryRows(db, 'seniority', [{ label: 'Retired level' }]))
      await archiveRegistryRow(db, 'seniority', seniorityId)
      const { id } = await addOne(db, role('Acme', 'One'))
      const error = await thrownBy(() => updatePosition(db, id, { seniorityId, city: 'Porto' }))
      return { error, stored: (await getPosition(db, id)).position }
    })

    // Assert
    expect(error).toBeInstanceOf(ArchivedError)
    expect(stored.city).toBeNull()
  })

  test('accepts a whole object whose reference is unchanged but has since been archived', async () => {
    // Arrange / Act: the web app sends back every field it holds, the seniority included
    const { updated, stored } = await withMigratedScratchDatabase(async (db) => {
      const seniorityId = idOf(await addRegistryRows(db, 'seniority', [{ label: 'Retired later' }]))
      const { id } = await addOne(db, role('Acme', 'One', { seniorityId }))
      await archiveRegistryRow(db, 'seniority', seniorityId)
      const updated = await updatePosition(db, id, { seniorityId, city: 'Porto' })
      return { updated, stored: (await getPosition(db, id)).position }
    })

    // Assert: archival blocks a new reference, not one already held
    expect(updated.city).toBe('Porto')
    expect(stored.seniorityId).toBe(updated.seniorityId as number)
  })

  test('refuses a changed reference to an archived row even when another is stored', async () => {
    // Arrange / Act
    const { error, stored } = await withMigratedScratchDatabase(async (db) => {
      const levels = await addRegistryRows(db, 'seniority', [{ label: 'Held' }, { label: 'Retired' }])
      await archiveRegistryRow(db, 'seniority', idOf(levels, 1))
      const { id } = await addOne(db, role('Acme', 'One', { seniorityId: idOf(levels, 0) }))
      const error = await thrownBy(() => updatePosition(db, id, { seniorityId: idOf(levels, 1) }))
      return { error, stored: (await getPosition(db, id)).position }
    })

    // Assert
    expect(error).toBeInstanceOf(ArchivedError)
    expect(stored.seniorityId).not.toBeNull()
  })

  test('ignores a company, a key and import timestamps that a wider patch carries at runtime', async () => {
    // Arrange: more than the patch type allows, as a UI object spread into a patch would carry
    const original = await withMigratedScratchDatabase(async (db) => {
      const created = await addOne(db, role('Acme', 'One'))
      const [other] = await addPositions(db, [role('Other Co', 'Two')])
      const wider = {
        city: 'Porto',
        companyId: (other as Position).companyId,
        positionKey: 'hijacked',
        firstImportedAt: new Date('2001-01-01T00:00:00Z'),
        lastImportedAt: new Date('2001-01-01T00:00:00Z'),
      } as PositionPatch
      return { created, updated: await updatePosition(db, created.id, wider) }
    })

    // Assert: the editable column changed, and nothing the type says is not patchable did
    const { created, updated } = original
    expect(updated.city).toBe('Porto')
    expect(updated.companyId).toBe(created.companyId)
    expect(updated.positionKey).toBe(created.positionKey)
    expect(updated.firstImportedAt).toEqual(created.firstImportedAt)
    expect(updated.lastImportedAt).toEqual(created.lastImportedAt)
  })

  test('raises NotFoundError for an id with no position', async () => {
    // Arrange / Act
    const error = await withMigratedScratchDatabase((db) => thrownBy(() => updatePosition(db, 4242, { city: 'Porto' })))

    // Assert
    expect(error).toBeInstanceOf(NotFoundError)
  })

  test('returns the row as it is for an empty patch', async () => {
    // Arrange / Act
    const { stored, same, missing } = await withMigratedScratchDatabase(async (db) => {
      const { id } = await addOne(db, role('Acme', 'One'))
      return {
        stored: (await getPosition(db, id)).position,
        same: await updatePosition(db, id, {}),
        missing: await thrownBy(() => updatePosition(db, 4242, {})),
      }
    })

    // Assert
    expect(same).toEqual(stored)
    expect(missing).toBeInstanceOf(NotFoundError)
  })

  test('the patch schema refuses a field that is not editable and an empty patch', () => {
    // Assert
    expect(PositionPatchSchema.safeParse({ priorityRank: 1 }).success).toBe(true)
    expect(PositionPatchSchema.safeParse({ companyId: 2 }).success).toBe(false)
    expect(PositionPatchSchema.safeParse({ positionKey: 'x' }).success).toBe(false)
    expect(PositionPatchSchema.safeParse({ firstImportedAt: '2026-01-01' }).success).toBe(false)
    expect(PositionPatchSchema.safeParse({}).success).toBe(false)
  })
})
