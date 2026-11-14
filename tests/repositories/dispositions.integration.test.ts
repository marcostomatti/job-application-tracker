import { describe, expect, test } from 'bun:test'
import { asc, count, eq, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import type { DrizzleClient } from '../../src/data/client.ts'
import {
  appendStageEvent,
  currentStage,
  groupBySetAsideReason,
  isApplied,
  listSetAside,
  moveIfRecommended,
  recordRejection,
  setAside,
  stageHistory,
} from '../../src/data/repositories/dispositions.ts'
import { addPostings, searchPostings, type Posting } from '../../src/data/repositories/postings.ts'
import { addRegistryRows, archiveRegistryRow } from '../../src/data/repositories/registries.ts'
import { postingDisposition, postingStageEvent } from '../../src/data/schema/dispositions.ts'
import { ArchivedError, NotFoundError, statusFor } from '../../src/errors.ts'
import type { RegistryRowInputOf } from '../../src/schemas/registries.ts'
import { PostingQuerySchema } from '../../src/schemas/postings.ts'
import { thrownBy } from '../data/rolled-back.ts'
import { withMigratedScratchDatabase } from '../data/scratch-database.ts'

const DISPOSITION_CHECK = 'posting_disposition_kind_reason_check'

/** The id at `index`, or a loud failure: an absent row would otherwise read as a pass. */
function idOf(rows: readonly { readonly id: number }[], index = 0): number {
  const id = rows[index]?.id
  if (id === undefined) throw new Error(`the arrangement produced no row at index ${index}`)
  return id
}

async function addPosting(db: DrizzleClient, title = 'Staff Engineer'): Promise<Posting> {
  const [added] = await addPostings(db, [{ company: { name: `${title} Co` }, roleTitle: title }])
  if (!added) throw new Error('the arrangement stored no posting')
  return added
}

async function addStage(db: DrizzleClient, key: string, flags: Omit<RegistryRowInputOf<'stage'>, 'key' | 'label'> = {}): Promise<number> {
  return idOf(await addRegistryRows(db, 'stage', [{ key, label: `Stage ${key}`, ...flags }]))
}

async function addPhase(db: DrizzleClient, key: string, flags: Omit<RegistryRowInputOf<'phase'>, 'key' | 'label'> = {}): Promise<number> {
  return idOf(await addRegistryRows(db, 'phase', [{ key, label: `Phase ${key}`, ...flags }]))
}

async function eventCount(db: DrizzleClient, postingId?: number): Promise<number> {
  const [found] = await db
    .select({ n: count() })
    .from(postingStageEvent)
    .where(postingId === undefined ? undefined : eq(postingStageEvent.postingId, postingId))
  return found?.n ?? 0
}

/** A shortlist phase holding one open stage, which is all the move rule needs to fire. */
async function shortlistWithOneStage(db: DrizzleClient): Promise<{ phaseId: number; stageId: number }> {
  const phaseId = await addPhase(db, 'shortlist', { isShortlist: true })
  return { phaseId, stageId: await addStage(db, 'queued', { phaseId }) }
}

/**
 * How many events the tie-break test writes under one instant: enough that storage order and
 * id order part ways when the scan is sequential.
 */
const TIED_EVENTS = 10

describe('appendStageEvent', () => {
  test('stores the event with its stage, its note and an instant of its own', async () => {
    // Arrange / Act
    const { event, stored } = await withMigratedScratchDatabase(async (db) => {
      const target = await addPosting(db)
      const stageId = await addStage(db, 'screen')
      const at = new Date('2026-03-01T10:00:00Z')
      const written = await appendStageEvent(db, { postingId: target.id, stageId, occurredAt: at, note: 'phone screen' })
      return { event: written, stored: await db.select().from(postingStageEvent) }
    })

    // Assert
    expect(stored).toEqual([event])
    expect(event.note).toBe('phone screen')
    expect(event.occurredAt.toISOString()).toBe('2026-03-01T10:00:00.000Z')
  })

  test('stores an event with no stage and dates it when it is recorded', async () => {
    // Arrange / Act: the stage registry ships empty, so a null stage is the normal fresh-install state
    const { event, before, after } = await withMigratedScratchDatabase(async (db) => {
      const target = await addPosting(db)
      const earlier = new Date()
      const written = await appendStageEvent(db, { postingId: target.id, stageId: null })
      return { event: written, before: earlier, after: new Date() }
    })

    // Assert
    expect(event.stageId).toBeNull()
    expect(event.note).toBeNull()
    expect(event.occurredAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000)
    expect(event.occurredAt.getTime()).toBeLessThanOrEqual(after.getTime() + 1000)
  })

  test('refuses an archived stage, an unknown stage and an unknown posting, writing nothing', async () => {
    // Arrange / Act
    const { archived, unknownStage, unknownPosting, events } = await withMigratedScratchDatabase(async (db) => {
      const target = await addPosting(db)
      const stageId = await addStage(db, 'old')
      await archiveRegistryRow(db, 'stage', stageId)
      const liveStageId = await addStage(db, 'live')
      return {
        archived: await thrownBy(() => appendStageEvent(db, { postingId: target.id, stageId })),
        unknownStage: await thrownBy(() => appendStageEvent(db, { postingId: target.id, stageId: 999_999 })),
        unknownPosting: await thrownBy(() => appendStageEvent(db, { postingId: 999_999, stageId: liveStageId })),
        events: await eventCount(db),
      }
    })

    // Assert
    expect(archived).toBeInstanceOf(ArchivedError)
    expect(unknownStage).toBeInstanceOf(NotFoundError)
    expect(unknownPosting).toBeInstanceOf(NotFoundError)
    expect(statusFor(unknownPosting)).toBe(404)
    expect(events).toBe(0)
  })

  test('a repeatable stage can occur twice, and both rows are counted', async () => {
    // Arrange / Act: nothing in the table makes posting and stage unique
    const { occurrences, latest } = await withMigratedScratchDatabase(async (db) => {
      const target = await addPosting(db)
      const interview = await addStage(db, 'interview', { isRepeatable: true })
      await appendStageEvent(db, { postingId: target.id, stageId: interview, note: 'round one' })
      await appendStageEvent(db, { postingId: target.id, stageId: interview, note: 'round two' })
      const rows = await db
        .select()
        .from(postingStageEvent)
        .where(eq(postingStageEvent.stageId, interview))
        .orderBy(asc(postingStageEvent.id))
      return { occurrences: rows.length, latest: await currentStage(db, target.id) }
    })

    // Assert
    expect(occurrences).toBe(2)
    expect(latest?.event.note).toBe('round two')
  })
})

describe('currentStage', () => {
  test('returns null when the posting has no event', async () => {
    // Arrange / Act
    const found = await withMigratedScratchDatabase(async (db) => currentStage(db, (await addPosting(db)).id))

    // Assert
    expect(found).toBeNull()
  })

  test('raises NotFoundError for a posting that does not exist, and null for one with no events', async () => {
    // Arrange / Act
    const { missing, noEvents } = await withMigratedScratchDatabase(async (db) => ({
      missing: await thrownBy(() => currentStage(db, 999_999)),
      noEvents: await currentStage(db, (await addPosting(db)).id),
    }))

    // Assert
    expect(missing).toBeInstanceOf(NotFoundError)
    expect(statusFor(missing)).toBe(404)
    expect(noEvents).toBeNull()
  })

  test('returns the latest event by time, not the last one written', async () => {
    // Arrange / Act: the later-dated event is written first, so the highest id is not the latest
    const found = await withMigratedScratchDatabase(async (db) => {
      const target = await addPosting(db)
      const later = await addStage(db, 'later')
      const earlier = await addStage(db, 'earlier')
      await appendStageEvent(db, { postingId: target.id, stageId: later, occurredAt: new Date('2026-03-02T00:00:00Z') })
      await appendStageEvent(db, { postingId: target.id, stageId: earlier, occurredAt: new Date('2026-03-01T00:00:00Z') })
      return currentStage(db, target.id)
    })

    // Assert
    expect(found?.stage.label).toBe('Stage later')
  })

  test('breaks a tie between events at one instant by id, under a sequential scan', async () => {
    // Arrange / Act: with the (posting, time, id) index the highest id comes back on its own,
    // which would hide a missing `id desc`; a sequential scan returns storage order, so only
    // the ORDER BY decides among ten events sharing one timestamp.
    const { found, expected } = await withMigratedScratchDatabase(async (db) => {
      const target = await addPosting(db)
      const stageIds = await Promise.all(
        Array.from({ length: TIED_EVENTS }, (_, index) => addStage(db, `tie-${index}`)),
      )
      await db.execute(sql`set enable_indexscan = off`)
      await db.execute(sql`set enable_bitmapscan = off`)
      const at = new Date('2026-02-01T09:00:00Z')
      await db.insert(postingStageEvent).values(stageIds.map((stageId) => ({ postingId: target.id, stageId, occurredAt: at })))
      return { found: await currentStage(db, target.id), expected: stageIds[TIED_EVENTS - 1] }
    })

    // Assert
    expect(found?.stage.id).toBe(expected as number)
  })

  test('returns null when the latest event has a null stage, even if an earlier one had a stage', async () => {
    // Arrange / Act
    const found = await withMigratedScratchDatabase(async (db) => {
      const target = await addPosting(db)
      const stageId = await addStage(db, 'earlier')
      await appendStageEvent(db, { postingId: target.id, stageId, occurredAt: new Date('2026-03-01T00:00:00Z') })
      await appendStageEvent(db, { postingId: target.id, stageId: null, occurredAt: new Date('2026-03-02T00:00:00Z') })
      return currentStage(db, target.id)
    })

    // Assert
    expect(found).toBeNull()
  })

  test('still returns a stage archived after the event was recorded, with its flags', async () => {
    // Arrange / Act
    const found = await withMigratedScratchDatabase(async (db) => {
      const target = await addPosting(db)
      const stageId = await addStage(db, 'filed', { isTraction: true, isApplied: true })
      await appendStageEvent(db, { postingId: target.id, stageId })
      await archiveRegistryRow(db, 'stage', stageId)
      return currentStage(db, target.id)
    })

    // Assert: an archived row still renders its label
    expect(found?.stage.label).toBe('Stage filed')
    expect(found?.stage.archivedAt).not.toBeNull()
    expect(found?.stage.isApplied).toBe(true)
    expect(found?.stage.isTraction).toBe(true)
  })
})

describe('stageHistory', () => {
  test('raises NotFoundError for a posting that does not exist, and an empty list for one with no events', async () => {
    // Arrange / Act
    const { missing, noEvents } = await withMigratedScratchDatabase(async (db) => ({
      missing: await thrownBy(() => stageHistory(db, 999_999)),
      noEvents: await stageHistory(db, (await addPosting(db)).id),
    }))

    // Assert
    expect(missing).toBeInstanceOf(NotFoundError)
    expect(statusFor(missing)).toBe(404)
    expect(noEvents).toEqual([])
  })

  test('returns every event oldest first by time, not in the order written', async () => {
    // Arrange / Act: the later-dated event is written first, so id order and time order differ
    const { history, later, earlier } = await withMigratedScratchDatabase(async (db) => {
      const target = await addPosting(db)
      const laterId = await addStage(db, 'history-later')
      const earlierId = await addStage(db, 'history-earlier')
      await appendStageEvent(db, { postingId: target.id, stageId: laterId, occurredAt: new Date('2026-03-02T00:00:00Z') })
      await appendStageEvent(db, { postingId: target.id, stageId: earlierId, occurredAt: new Date('2026-03-01T00:00:00Z') })
      return { history: await stageHistory(db, target.id), later: laterId, earlier: earlierId }
    })

    // Assert
    expect(history.map((row) => row.stage?.id)).toEqual([earlier, later])
    expect(history.map((row) => row.event.stageId)).toEqual([earlier, later])
  })

  test('breaks a tie between events at one instant by id, under a sequential scan', async () => {
    // Arrange / Act: a sequential scan returns storage order, so only the ORDER BY decides
    const { history, expected } = await withMigratedScratchDatabase(async (db) => {
      const target = await addPosting(db)
      const stageIds = await Promise.all(
        Array.from({ length: TIED_EVENTS }, (_, index) => addStage(db, `history-tie-${index}`)),
      )
      await db.execute(sql`set enable_indexscan = off`)
      await db.execute(sql`set enable_bitmapscan = off`)
      const at = new Date('2026-02-01T09:00:00Z')
      const written = await db
        .insert(postingStageEvent)
        .values(stageIds.map((stageId) => ({ postingId: target.id, stageId, occurredAt: at })))
        .returning({ id: postingStageEvent.id })
      return { history: await stageHistory(db, target.id), expected: written.map((row) => row.id).sort((a, b) => a - b) }
    })

    // Assert
    expect(history.map((row) => row.event.id)).toEqual(expected)
  })

  test('keeps an event with no stage, with a null stage beside it', async () => {
    // Arrange / Act
    const history = await withMigratedScratchDatabase(async (db) => {
      const target = await addPosting(db)
      const stageId = await addStage(db, 'history-before-null')
      await appendStageEvent(db, { postingId: target.id, stageId, occurredAt: new Date('2026-03-01T00:00:00Z') })
      await appendStageEvent(db, { postingId: target.id, stageId: null, occurredAt: new Date('2026-03-02T00:00:00Z') })
      return stageHistory(db, target.id)
    })

    // Assert
    expect(history).toHaveLength(2)
    expect(history[0]?.stage?.label).toBe('Stage history-before-null')
    expect(history[1]?.event.stageId).toBeNull()
    expect(history[1]?.stage).toBeNull()
  })

  test('returns a stage archived after the event, and only the events of the posting asked about', async () => {
    // Arrange / Act
    const { history, target } = await withMigratedScratchDatabase(async (db) => {
      const asked = await addPosting(db, 'History asked')
      const other = await addPosting(db, 'History other')
      const stageId = await addStage(db, 'history-archived', { isApplied: true })
      await appendStageEvent(db, { postingId: asked.id, stageId })
      await appendStageEvent(db, { postingId: other.id, stageId })
      await archiveRegistryRow(db, 'stage', stageId)
      return { history: await stageHistory(db, asked.id), target: asked.id }
    })

    // Assert
    expect(history).toHaveLength(1)
    expect(history[0]?.event.postingId).toBe(target)
    expect(history[0]?.stage?.archivedAt).not.toBeNull()
    expect(history[0]?.stage?.isApplied).toBe(true)
  })
})

describe('isApplied', () => {
  test('is false for a posting with no event', async () => {
    // Arrange / Act
    const applied = await withMigratedScratchDatabase(async (db) => isApplied(db, (await addPosting(db)).id))

    // Assert
    expect(applied).toBe(false)
  })

  test('raises NotFoundError for a posting that does not exist, and false for one with no events', async () => {
    // Arrange / Act
    const { missing, noEvents } = await withMigratedScratchDatabase(async (db) => ({
      missing: await thrownBy(() => isApplied(db, 999_999)),
      noEvents: await isApplied(db, (await addPosting(db)).id),
    }))

    // Assert
    expect(missing).toBeInstanceOf(NotFoundError)
    expect(statusFor(missing)).toBe(404)
    expect(noEvents).toBe(false)
  })

  test('is false when the latest stage is null', async () => {
    // Arrange / Act: a null stage is the normal state of a fresh install, not an applied one
    const applied = await withMigratedScratchDatabase(async (db) => {
      const target = await addPosting(db)
      await appendStageEvent(db, { postingId: target.id, stageId: null })
      return isApplied(db, target.id)
    })

    // Assert
    expect(applied).toBe(false)
  })

  test('is false when the latest stage does not carry is_applied', async () => {
    // Arrange / Act
    const applied = await withMigratedScratchDatabase(async (db) => {
      const target = await addPosting(db)
      await appendStageEvent(db, { postingId: target.id, stageId: await addStage(db, 'screen') })
      return isApplied(db, target.id)
    })

    // Assert
    expect(applied).toBe(false)
  })

  test('is true when the latest stage carries is_applied, even if it is archived by now', async () => {
    // Arrange / Act
    const applied = await withMigratedScratchDatabase(async (db) => {
      const target = await addPosting(db)
      const stageId = await addStage(db, 'filed', { isApplied: true })
      await appendStageEvent(db, { postingId: target.id, stageId })
      await archiveRegistryRow(db, 'stage', stageId)
      return isApplied(db, target.id)
    })

    // Assert
    expect(applied).toBe(true)
  })

  test('is false when an earlier event was applied but the latest is not', async () => {
    // Arrange / Act
    const applied = await withMigratedScratchDatabase(async (db) => {
      const target = await addPosting(db)
      const filed = await addStage(db, 'filed', { isApplied: true })
      const other = await addStage(db, 'other')
      await appendStageEvent(db, { postingId: target.id, stageId: filed, occurredAt: new Date('2026-03-01T00:00:00Z') })
      await appendStageEvent(db, { postingId: target.id, stageId: other, occurredAt: new Date('2026-03-02T00:00:00Z') })
      return isApplied(db, target.id)
    })

    // Assert
    expect(applied).toBe(false)
  })

  test('breaks a tie between events at one instant by id, under a sequential scan', async () => {
    // Arrange / Act: nine events at one instant carry no flag and the highest id is the applied one,
    // so a missing `id desc` under a sequential scan reads the lowest id, which is not applied
    const applied = await withMigratedScratchDatabase(async (db) => {
      const target = await addPosting(db)
      const plain = await Promise.all(Array.from({ length: TIED_EVENTS - 1 }, (_, index) => addStage(db, `plain-${index}`)))
      const filed = await addStage(db, 'filed', { isApplied: true })
      await db.execute(sql`set enable_indexscan = off`)
      await db.execute(sql`set enable_bitmapscan = off`)
      const at = new Date('2026-02-01T09:00:00Z')
      await db
        .insert(postingStageEvent)
        .values([...plain, filed].map((stageId) => ({ postingId: target.id, stageId, occurredAt: at })))
      return isApplied(db, target.id)
    })

    // Assert
    expect(applied).toBe(true)
  })
})

describe('setAside and recordRejection', () => {
  test('setAside stores a set-aside reason and no rejection reason', async () => {
    // Arrange / Act
    const { disposition, reasonId } = await withMigratedScratchDatabase(async (db) => {
      const target = await addPosting(db)
      const reasonId = idOf(await addRegistryRows(db, 'set_aside_reason', [{ label: 'Too far' }]))
      return { disposition: await setAside(db, { postingId: target.id, setAsideReasonId: reasonId, note: 'two hours each way' }), reasonId }
    })

    // Assert
    expect(disposition.kind).toBe('set_aside')
    expect(disposition.setAsideReasonId).toBe(reasonId)
    expect(disposition.rejectionReasonId).toBeNull()
    expect(disposition.note).toBe('two hours each way')
  })

  test('recordRejection stores a rejection reason and no set-aside reason', async () => {
    // Arrange / Act
    const { disposition, reasonId } = await withMigratedScratchDatabase(async (db) => {
      const target = await addPosting(db)
      const reasonId = idOf(await addRegistryRows(db, 'rejection_reason', [{ label: 'No reply' }]))
      return { disposition: await recordRejection(db, { postingId: target.id, rejectionReasonId: reasonId }), reasonId }
    })

    // Assert
    expect(disposition.kind).toBe('rejected')
    expect(disposition.rejectionReasonId).toBe(reasonId)
    expect(disposition.setAsideReasonId).toBeNull()
    expect(disposition.note).toBeNull()
  })

  test('neither touches the posting stage', async () => {
    // Arrange / Act
    const { events, stage } = await withMigratedScratchDatabase(async (db) => {
      const target = await addPosting(db)
      const asideReason = idOf(await addRegistryRows(db, 'set_aside_reason', [{ label: 'Too far' }]))
      const rejection = idOf(await addRegistryRows(db, 'rejection_reason', [{ label: 'No reply' }]))
      await setAside(db, { postingId: target.id, setAsideReasonId: asideReason })
      await recordRejection(db, { postingId: target.id, rejectionReasonId: rejection })
      return { events: await eventCount(db), stage: await currentStage(db, target.id) }
    })

    // Assert
    expect(events).toBe(0)
    expect(stage).toBeNull()
  })

  test('refuses an archived reason, an unknown reason and an unknown posting, writing nothing', async () => {
    // Arrange / Act
    const results = await withMigratedScratchDatabase(async (db) => {
      const target = await addPosting(db)
      const retired = idOf(await addRegistryRows(db, 'set_aside_reason', [{ label: 'Retired' }]))
      await archiveRegistryRow(db, 'set_aside_reason', retired)
      const live = idOf(await addRegistryRows(db, 'rejection_reason', [{ label: 'Live' }]))
      await archiveRegistryRow(db, 'rejection_reason', idOf(await addRegistryRows(db, 'rejection_reason', [{ label: 'Gone' }])))
      return {
        archivedAside: await thrownBy(() => setAside(db, { postingId: target.id, setAsideReasonId: retired })),
        unknownAside: await thrownBy(() => setAside(db, { postingId: target.id, setAsideReasonId: 999_999 })),
        unknownRejection: await thrownBy(() => recordRejection(db, { postingId: target.id, rejectionReasonId: 999_999 })),
        unknownPosting: await thrownBy(() => recordRejection(db, { postingId: 999_999, rejectionReasonId: live })),
        stored: (await db.select({ n: count() }).from(postingDisposition))[0]?.n,
      }
    })

    // Assert
    expect(results.archivedAside).toBeInstanceOf(ArchivedError)
    expect(results.unknownAside).toBeInstanceOf(NotFoundError)
    expect(results.unknownRejection).toBeInstanceOf(NotFoundError)
    expect(results.unknownPosting).toBeInstanceOf(NotFoundError)
    expect(results.stored).toBe(0)
  })

  test('a reason a caller bypassing the schema leaves out is a typed error with no SQL in it', async () => {
    // Arrange / Act: the schema makes the reason required, so only a caller that skipped it can send null
    const error = await withMigratedScratchDatabase(async (db) => {
      const target = await addPosting(db)
      return thrownBy(() => setAside(db, { postingId: target.id, setAsideReasonId: null as unknown as number }))
    })

    // Assert
    expect(error).toBeInstanceOf(NotFoundError)
    expect((error as Error).message).not.toMatch(/insert|select|violates|constraint/i)
  })

  test('the database still refuses a row that carries the wrong reason for its kind', async () => {
    // Arrange / Act: written straight to the table, past the two typed signatures
    const { aside, rejected, both } = await withMigratedScratchDatabase(async (db) => {
      const target = await addPosting(db)
      const asideReason = idOf(await addRegistryRows(db, 'set_aside_reason', [{ label: 'Too far' }]))
      const rejection = idOf(await addRegistryRows(db, 'rejection_reason', [{ label: 'No reply' }]))
      const attempt = (values: typeof postingDisposition.$inferInsert) => thrownBy(() => db.insert(postingDisposition).values(values))
      return {
        aside: await attempt({ postingId: target.id, kind: 'set_aside', rejectionReasonId: rejection }),
        rejected: await attempt({ postingId: target.id, kind: 'rejected', setAsideReasonId: asideReason }),
        both: await attempt({ postingId: target.id, kind: 'rejected', setAsideReasonId: asideReason, rejectionReasonId: rejection }),
      }
    })

    // Assert: the guarantee is the database's, so the check name is on the fault's cause
    for (const error of [aside, rejected, both]) {
      expect(String((error as { cause?: { constraint_name?: string } }).cause?.constraint_name)).toBe(DISPOSITION_CHECK)
    }
  })
})

describe('listSetAside', () => {
  test('is empty when nothing was set aside', async () => {
    // Arrange / Act
    const groups = await withMigratedScratchDatabase(async (db) => {
      await addPosting(db)
      return listSetAside(db)
    })

    // Assert
    expect(groups).toEqual([])
  })

  test('groups by reason and leaves rejected postings out', async () => {
    // Arrange / Act
    const groups = await withMigratedScratchDatabase(async (db) => {
      const far = await addPosting(db, 'Far')
      const pay = await addPosting(db, 'Pay')
      const rejectedOnly = await addPosting(db, 'Rejected only')
      await addPosting(db, 'Untouched')
      const tooFar = idOf(await addRegistryRows(db, 'set_aside_reason', [{ label: 'Too far' }]))
      const lowPay = idOf(await addRegistryRows(db, 'set_aside_reason', [{ label: 'Low pay' }]))
      const noReply = idOf(await addRegistryRows(db, 'rejection_reason', [{ label: 'No reply' }]))
      await setAside(db, { postingId: far.id, setAsideReasonId: tooFar })
      await setAside(db, { postingId: pay.id, setAsideReasonId: lowPay })
      await recordRejection(db, { postingId: rejectedOnly.id, rejectionReasonId: noReply })
      return listSetAside(db)
    })

    // Assert
    expect(groups.map((group) => [group.reasonLabel, group.postings.map((row) => row.posting.roleTitle)])).toEqual([
      ['Too far', ['Far']],
      ['Low pay', ['Pay']],
    ])
    expect(groups.every((group) => group.postings.every((row) => row.setAside))).toBe(true)
  })

  test('puts a posting in the group of its latest set-aside reason only', async () => {
    // Arrange / Act
    const groups = await withMigratedScratchDatabase(async (db) => {
      const target = await addPosting(db)
      const first = idOf(await addRegistryRows(db, 'set_aside_reason', [{ label: 'First thought' }]))
      const second = idOf(await addRegistryRows(db, 'set_aside_reason', [{ label: 'Second thought' }]))
      await setAside(db, { postingId: target.id, setAsideReasonId: first })
      await setAside(db, { postingId: target.id, setAsideReasonId: second })
      return listSetAside(db)
    })

    // Assert
    expect(groups.map((group) => group.reasonLabel)).toEqual(['Second thought'])
    expect(groups[0]?.postings).toHaveLength(1)
  })

  test('keeps a posting that was later rejected, under the reason it was set aside for', async () => {
    // Arrange / Act: set-aside and rejection are separate axes, so a rejection does not erase a set-aside
    const groups = await withMigratedScratchDatabase(async (db) => {
      const target = await addPosting(db)
      const reason = idOf(await addRegistryRows(db, 'set_aside_reason', [{ label: 'Too far' }]))
      const rejection = idOf(await addRegistryRows(db, 'rejection_reason', [{ label: 'No reply' }]))
      await setAside(db, { postingId: target.id, setAsideReasonId: reason })
      await recordRejection(db, { postingId: target.id, rejectionReasonId: rejection })
      return listSetAside(db)
    })

    // Assert
    expect(groups.map((group) => group.reasonLabel)).toEqual(['Too far'])
  })

  test('still names a reason archived after it was used, and carries each posting stage', async () => {
    // Arrange / Act
    const groups = await withMigratedScratchDatabase(async (db) => {
      const target = await addPosting(db)
      const reason = idOf(await addRegistryRows(db, 'set_aside_reason', [{ label: 'Too far' }]))
      const stageId = await addStage(db, 'screen')
      await appendStageEvent(db, { postingId: target.id, stageId })
      await setAside(db, { postingId: target.id, setAsideReasonId: reason })
      await archiveRegistryRow(db, 'set_aside_reason', reason)
      return listSetAside(db)
    })

    // Assert
    expect(groups[0]?.reasonLabel).toBe('Too far')
    expect(groups[0]?.postings[0]?.stage?.label).toBe('Stage screen')
  })

  test('lists every set-aside posting, past one page of the search it is built on', async () => {
    // Arrange / Act
    const { total, listed } = await withMigratedScratchDatabase(async (db) => {
      const reason = idOf(await addRegistryRows(db, 'set_aside_reason', [{ label: 'Too far' }]))
      const created = await addPostings(
        db,
        Array.from({ length: 205 }, (_, index) => ({ company: { name: `Bulk Co ${index}` }, roleTitle: 'Engineer' })),
      )
      await db.insert(postingDisposition).values(created.map((row) => ({ postingId: row.id, kind: 'set_aside', setAsideReasonId: reason })))
      const groups = await listSetAside(db)
      return { total: created.length, listed: groups.flatMap((group) => group.postings).length }
    })

    // Assert
    expect(listed).toBe(total)
  })

  test('includes a client-hidden posting, because the user set it aside themselves', async () => {
    // Arrange / Act
    const groups = await withMigratedScratchDatabase(async (db) => {
      const [hidden] = await addPostings(db, [{ company: { name: 'Hidden Co' }, roleTitle: 'Engineer', clientHidden: true }])
      const reason = idOf(await addRegistryRows(db, 'set_aside_reason', [{ label: 'Too far' }]))
      await setAside(db, { postingId: (hidden as Posting).id, setAsideReasonId: reason })
      return listSetAside(db)
    })

    // Assert
    expect(groups[0]?.postings.map((row) => row.posting.clientHidden)).toEqual([true])
  })
})

describe('groupBySetAsideReason', () => {
  test('lists a posting once when paging read it on two pages', async () => {
    // Arrange / Act: the same row twice, as offset paging can return it after a concurrent touch
    const groups = await withMigratedScratchDatabase(async (db) => {
      const target = await addPosting(db)
      const reason = idOf(await addRegistryRows(db, 'set_aside_reason', [{ label: 'Too far' }]))
      await setAside(db, { postingId: target.id, setAsideReasonId: reason })
      const rows = await searchPostings(db, PostingQuerySchema.parse({ setAside: 'only' }))
      return groupBySetAsideReason([...rows, ...rows], new Map([[target.id, { reasonId: reason, reasonLabel: 'Too far' }]]))
    })

    // Assert
    expect(groups).toHaveLength(1)
    expect(groups[0]?.postings).toHaveLength(1)
  })
})

describe('moveIfRecommended', () => {
  test('appends an event in the shortlist phase when a score recommends applying', async () => {
    // Arrange / Act
    const { moved, now, phaseStageId } = await withMigratedScratchDatabase(async (db) => {
      const target = await addPosting(db)
      const { stageId } = await shortlistWithOneStage(db)
      const moved = await moveIfRecommended(db, { postingId: target.id, recommendApply: true })
      return { moved, now: await currentStage(db, target.id), phaseStageId: stageId }
    })

    // Assert
    expect(moved?.stageId).toBe(phaseStageId)
    expect(now?.stage.id).toBe(phaseStageId)
  })

  test('moves a posting whose only event has a null stage', async () => {
    // Arrange / Act: a null stage is not applied, so the gate must let it through
    const { moved, applied } = await withMigratedScratchDatabase(async (db) => {
      const target = await addPosting(db)
      await appendStageEvent(db, { postingId: target.id, stageId: null })
      await shortlistWithOneStage(db)
      const applied = await isApplied(db, target.id)
      return { moved: await moveIfRecommended(db, { postingId: target.id, recommendApply: true }), applied }
    })

    // Assert
    expect(applied).toBe(false)
    expect(moved).not.toBeNull()
  })

  test('writes nothing when the score does not recommend applying', async () => {
    // Arrange / Act
    const { moved, events } = await withMigratedScratchDatabase(async (db) => {
      const target = await addPosting(db)
      await shortlistWithOneStage(db)
      return { moved: await moveIfRecommended(db, { postingId: target.id, recommendApply: false }), events: await eventCount(db) }
    })

    // Assert
    expect(moved).toBeNull()
    expect(events).toBe(0)
  })

  test('writes nothing when the posting is already applied', async () => {
    // Arrange / Act
    const { moved, events, stage } = await withMigratedScratchDatabase(async (db) => {
      const target = await addPosting(db)
      await shortlistWithOneStage(db)
      const filed = await addStage(db, 'filed', { isApplied: true })
      await appendStageEvent(db, { postingId: target.id, stageId: filed })
      return {
        moved: await moveIfRecommended(db, { postingId: target.id, recommendApply: true }),
        events: await eventCount(db),
        stage: await currentStage(db, target.id),
      }
    })

    // Assert
    expect(moved).toBeNull()
    expect(events).toBe(1)
    expect(stage?.stage.label).toBe('Stage filed')
  })

  test('returns null and writes nothing when no phase carries is_shortlist', async () => {
    // Arrange / Act: a fresh install has no phases at all, and a registry with some still has none flagged
    const { onEmpty, onUnflagged, events } = await withMigratedScratchDatabase(async (db) => {
      const target = await addPosting(db)
      const onEmpty = await moveIfRecommended(db, { postingId: target.id, recommendApply: true })
      const phaseId = await addPhase(db, 'plain')
      await addStage(db, 'somewhere', { phaseId })
      return {
        onEmpty,
        onUnflagged: await moveIfRecommended(db, { postingId: target.id, recommendApply: true }),
        events: await eventCount(db),
      }
    })

    // Assert
    expect(onEmpty).toBeNull()
    expect(onUnflagged).toBeNull()
    expect(events).toBe(0)
  })

  test('returns null when the shortlist phase has no stage, or only terminal or archived ones', async () => {
    // Arrange / Act
    const results = await withMigratedScratchDatabase(async (db) => {
      const target = await addPosting(db)
      const phaseId = await addPhase(db, 'shortlist', { isShortlist: true })
      const run = () => moveIfRecommended(db, { postingId: target.id, recommendApply: true })
      const noStage = await run()
      await addStage(db, 'closed', { phaseId, isTerminal: true })
      const onlyTerminal = await run()
      await archiveRegistryRow(db, 'stage', await addStage(db, 'retired', { phaseId }))
      const onlyArchived = await run()
      return { noStage, onlyTerminal, onlyArchived, events: await eventCount(db) }
    })

    // Assert
    expect(results.noStage).toBeNull()
    expect(results.onlyTerminal).toBeNull()
    expect(results.onlyArchived).toBeNull()
    expect(results.events).toBe(0)
  })

  test('skips a terminal stage when picking the shortlist stage', async () => {
    // Arrange / Act: the terminal stage sorts first, so only the flag keeps it from being chosen
    const { moved, openId } = await withMigratedScratchDatabase(async (db) => {
      const target = await addPosting(db)
      const phaseId = await addPhase(db, 'shortlist', { isShortlist: true })
      await addStage(db, 'closed', { phaseId, sort: 1, isTerminal: true })
      const openId = await addStage(db, 'open', { phaseId, sort: 2 })
      return { moved: await moveIfRecommended(db, { postingId: target.id, recommendApply: true }), openId }
    })

    // Assert
    expect(moved?.stageId).toBe(openId)
  })

  test('picks the lowest sort, not the first registered, and ignores stages of other phases', async () => {
    // Arrange / Act
    const { moved, lowestId } = await withMigratedScratchDatabase(async (db) => {
      const target = await addPosting(db)
      const phaseId = await addPhase(db, 'shortlist', { isShortlist: true })
      const otherPhase = await addPhase(db, 'other')
      await addStage(db, 'second', { phaseId, sort: 20 })
      await addStage(db, 'elsewhere', { phaseId: otherPhase, sort: 1 })
      const lowestId = await addStage(db, 'first', { phaseId, sort: 10 })
      return { moved: await moveIfRecommended(db, { postingId: target.id, recommendApply: true }), lowestId }
    })

    // Assert
    expect(moved?.stageId).toBe(lowestId)
  })

  test('breaks a tie between equally sorted stages by id, whatever order storage returns them in', async () => {
    // Arrange / Act: updating the first stage rewrites its row at the end of the table, so a
    // sequential scan returns it last and only the `id` in the ORDER BY puts it first again
    const { moved, firstId } = await withMigratedScratchDatabase(async (db) => {
      const target = await addPosting(db)
      const phaseId = await addPhase(db, 'shortlist', { isShortlist: true })
      const firstId = await addStage(db, 'a', { phaseId, sort: 5 })
      await addStage(db, 'b', { phaseId, sort: 5 })
      await addStage(db, 'c', { phaseId, sort: 5 })
      await db.execute(sql`update stage set label = 'Renamed' where id = ${firstId}`)
      await db.execute(sql`set enable_indexscan = off`)
      await db.execute(sql`set enable_bitmapscan = off`)
      return { moved: await moveIfRecommended(db, { postingId: target.id, recommendApply: true }), firstId }
    })

    // Assert
    expect(moved?.stageId).toBe(firstId)
  })

  test('prefers the lower-sorted of two shortlist phases, and skips an archived one', async () => {
    // Arrange / Act
    const { moved, inFirst } = await withMigratedScratchDatabase(async (db) => {
      const target = await addPosting(db)
      const archivedPhase = await addPhase(db, 'old', { isShortlist: true, sort: 1 })
      await addStage(db, 'in-old', { phaseId: archivedPhase })
      await archiveRegistryRow(db, 'phase', archivedPhase)
      const second = await addPhase(db, 'second', { isShortlist: true, sort: 30 })
      const first = await addPhase(db, 'first', { isShortlist: true, sort: 20 })
      await addStage(db, 'in-second', { phaseId: second, sort: 1 })
      const inFirst = await addStage(db, 'in-first', { phaseId: first, sort: 9 })
      return { moved: await moveIfRecommended(db, { postingId: target.id, recommendApply: true }), inFirst }
    })

    // Assert
    expect(moved?.stageId).toBe(inFirst)
  })

  test('breaks a tie between two shortlist phases of equal sort by phase id, ahead of the stage sort', async () => {
    // Arrange / Act: the older phase's stage sorts later, so only the phase id puts it first;
    // rewriting the older phase row moves it to the end of the table under a sequential scan
    const { moved, olderPhaseStageId } = await withMigratedScratchDatabase(async (db) => {
      const target = await addPosting(db)
      const older = await addPhase(db, 'older', { isShortlist: true, sort: 7 })
      const newer = await addPhase(db, 'newer', { isShortlist: true, sort: 7 })
      const olderPhaseStageId = await addStage(db, 'in-older', { phaseId: older, sort: 9 })
      await addStage(db, 'in-newer', { phaseId: newer, sort: 1 })
      await db.execute(sql`update phase set label = 'Renamed' where id = ${older}`)
      await db.execute(sql`set enable_indexscan = off`)
      await db.execute(sql`set enable_bitmapscan = off`)
      return { moved: await moveIfRecommended(db, { postingId: target.id, recommendApply: true }), olderPhaseStageId }
    })

    // Assert
    expect(moved?.stageId).toBe(olderPhaseStageId)
  })

  test('says nothing about an unknown posting when the score does not recommend applying', async () => {
    // Arrange / Act: the null is an answer about the input, so no read of the posting is made
    const moved = await withMigratedScratchDatabase(async (db) => {
      await shortlistWithOneStage(db)
      return moveIfRecommended(db, { postingId: 999_999, recommendApply: false })
    })

    // Assert
    expect(moved).toBeNull()
  })

  test('refuses an unknown posting even when nothing would be written', async () => {
    // Arrange / Act
    const error = await withMigratedScratchDatabase(async (db) => {
      await shortlistWithOneStage(db)
      return thrownBy(() => moveIfRecommended(db, { postingId: 999_999, recommendApply: true }))
    })

    // Assert
    expect(error).toBeInstanceOf(NotFoundError)
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

/** Two more connections to the scratch database: one that holds a transaction open, one that watches. */
async function withSecondConnections<T>(
  sql: postgres.Sql,
  body: (writer: postgres.Sql, observer: postgres.Sql) => Promise<T>,
): Promise<T> {
  const url = new URL(process.env.DATABASE_URL ?? '')
  url.pathname = `/${sql.options.database}`
  const writer = postgres(url.toString(), { max: 1, onnotice: () => {} })
  const observer = postgres(url.toString(), { max: 1, onnotice: () => {} })
  try {
    return await body(writer, observer)
  } finally {
    await writer.end()
    await observer.end()
  }
}

describe('the posting lock', () => {
  test('a re-score move waits for a transaction that is applying, then sees the application and moves nothing', async () => {
    // Arrange / Act: the writer takes the posting's row and files an application, uncommitted
    const { moved, events } = await withMigratedScratchDatabase(async (db, sql) => {
      const target = await addPosting(db)
      await shortlistWithOneStage(db)
      const filed = await addStage(db, 'filed', { isApplied: true })
      return withSecondConnections(sql, async (writer, observer) => {
        let attempt: Promise<unknown> = Promise.resolve()
        await writer.begin(async (transaction) => {
          await transaction`select id from posting where id = ${target.id} for no key update`
          await transaction`insert into posting_stage_event (posting_id, stage_id) values (${target.id}, ${filed})`
          attempt = moveIfRecommended(db, { postingId: target.id, recommendApply: true })
          await waitUntilABackendWaitsOnALock(observer)
        })
        return { moved: await attempt, events: await eventCount(db, target.id) }
      })
    })

    // Assert: without the lock the move would have read "not applied" and filed over the application
    expect(moved).toBeNull()
    expect(events).toBe(1)
  })

  test('appendStageEvent waits for a transaction holding the posting, then writes after it', async () => {
    // Arrange / Act
    const { notes } = await withMigratedScratchDatabase(async (db, sql) => {
      const target = await addPosting(db)
      const stageId = await addStage(db, 'screen')
      return withSecondConnections(sql, async (writer, observer) => {
        let attempt: Promise<unknown> = Promise.resolve()
        await writer.begin(async (transaction) => {
          await transaction`select id from posting where id = ${target.id} for no key update`
          await transaction`insert into posting_stage_event (posting_id, stage_id, note) values (${target.id}, ${stageId}, 'first')`
          attempt = appendStageEvent(db, { postingId: target.id, stageId, note: 'second' })
          await waitUntilABackendWaitsOnALock(observer)
        })
        await attempt
        const rows = await db.select().from(postingStageEvent).orderBy(asc(postingStageEvent.id))
        return { notes: rows.map((row) => row.note) }
      })
    })

    // Assert
    expect(notes).toEqual(['first', 'second'])
  })
})

describe('the date of an event written after a lock wait', () => {
  test('a transaction that began first but took the lock last is dated after the one it follows', async () => {
    // Arrange / Act: A begins, then R begins, takes the lock, files a shortlist event and commits;
    // only then does A take the lock and file its application. Dated at BEGIN, A's event would
    // precede R's and the posting would read as shortlisted again.
    const { applied, stage } = await withMigratedScratchDatabase(async (db, scratch) => {
      const target = await addPosting(db)
      await shortlistWithOneStage(db)
      const filed = await addStage(db, 'filed', { isApplied: true })
      return withSecondConnections(scratch, async (writer) => {
        const rescore = drizzle(writer)
        const begun = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        const application = db.transaction(async (tx) => {
          await tx.execute(sql`select 1`)
          begun.resolve()
          await release.promise
          await appendStageEvent(tx, { postingId: target.id, stageId: filed })
        })
        await begun.promise
        await Bun.sleep(50)
        await moveIfRecommended(rescore, { postingId: target.id, recommendApply: true })
        release.resolve()
        await application
        return { applied: await isApplied(db, target.id), stage: await currentStage(db, target.id) }
      })
    })

    // Assert
    expect(stage?.stage.label).toBe('Stage filed')
    expect(applied).toBe(true)
  })
})
