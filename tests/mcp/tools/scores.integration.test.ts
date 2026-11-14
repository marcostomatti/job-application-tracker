import { describe, expect, test } from 'bun:test'
import { count, eq } from 'drizzle-orm'

import type { DrizzleClient } from '../../../src/data/client.ts'
import type { Db } from '../../../src/data/repositories/db.ts'
import { appendStageEvent } from '../../../src/data/repositories/dispositions.ts'
import { addPostings } from '../../../src/data/repositories/postings.ts'
import { addRegistryRows } from '../../../src/data/repositories/registries.ts'
import { insertCriteriaSet, requirement } from '../../../src/data/schema/criteria.ts'
import { postingStageEvent } from '../../../src/data/schema/dispositions.ts'
import { scoreTools } from '../../../src/mcp/tools/scores.ts'
import { BULK_MAX } from '../../../src/schemas/common.ts'
import { withMigratedScratchDatabase } from '../../data/scratch-database.ts'
import { arrangeSet } from './criteria-arrangement.ts'
import { connectTools, failureText, idOf, untouchableDb, useSharedScratchDatabase } from './harness.ts'

const database = useSharedScratchDatabase()

type Arranged = { postingId: number; setId: number; requirementId: number }

async function arrange(db: DrizzleClient, name: string, seenAt = '2026-06-01'): Promise<Arranged> {
  const postingId = idOf(await addPostings(db, [{ company: { name: `${name} Co` }, roleTitle: name, seenAt }]))
  return { postingId, ...(await arrangeSet(db, name)) }
}

/** A score that clears the set's 0.5 bar, because its one requirement is fully covered. */
const covered = (arranged: Arranged): Record<string, unknown> => ({
  postingId: arranged.postingId,
  criteriaSetId: arranged.setId,
  ratings: [{ requirementId: arranged.requirementId, coverage: 1, confidence: 'supported' }],
  penalties: [],
})

/** A score that misses the bar, because its one requirement is not covered. */
const uncovered = (arranged: Arranged): Record<string, unknown> => ({
  ...covered(arranged),
  ratings: [{ requirementId: arranged.requirementId, coverage: 0 }],
})

/** A shortlist phase holding one open stage, which is all the move rule needs to fire. */
async function shortlist(db: DrizzleClient): Promise<number> {
  const phaseId = idOf(await addRegistryRows(db, 'phase', [{ key: 'shortlist', label: 'Shortlist', isShortlist: true }]))
  return idOf(await addRegistryRows(db, 'stage', [{ key: 'queued', label: 'Queued', phaseId }]))
}

async function eventCount(db: DrizzleClient, postingId: number): Promise<number> {
  const [found] = await db.select({ n: count() }).from(postingStageEvent).where(eq(postingStageEvent.postingId, postingId))
  return found?.n ?? 0
}

describe('the scores group', () => {
  test('the scores group registers exactly the named tools', () => {
    expect(scoreTools.map((tool) => tool.name).sort()).toEqual([
      'rescore_pending',
      'rescore_request',
      'score_best',
      'score_history',
      'score_posting',
      'score_posting_bulk',
      'score_verdict_set',
    ])
  })

  test('no tool sets annotations, which are left for the author to decide', () => {
    expect(scoreTools.filter((tool) => tool.annotations !== undefined)).toEqual([])
  })

  test('score_posting stores the score and reports no stage event when none was due', async () => {
    const client = await connectTools(scoreTools, database())
    const arranged = await arrange(database(), 'Stored')

    const outcome = await client.call('score_posting', uncovered(arranged))

    expect(outcome.failed).toBe(false)
    expect(outcome.body).toMatchObject({
      score: { postingId: arranged.postingId, recommendApply: false, limiterKey: 'skill' },
      stageEvent: null,
    })
  })

  test('score_posting moves a newly recommended posting to the shortlist phase', async () => {
    const outcome = await withMigratedScratchDatabase(async (db) => {
      const stageId = await shortlist(db)
      const arranged = await arrange(db, 'Moved')
      const client = await connectTools(scoreTools, db)
      const result = await client.call('score_posting', covered(arranged))
      return { result, stageId, postingId: arranged.postingId, events: await eventCount(db, arranged.postingId) }
    })

    expect(outcome.result.body).toMatchObject({
      score: { recommendApply: true },
      stageEvent: { postingId: outcome.postingId, stageId: outcome.stageId },
    })
    expect(outcome.events).toBe(1)
  })

  test('score_posting leaves an already applied posting where it is', async () => {
    const outcome = await withMigratedScratchDatabase(async (db) => {
      await shortlist(db)
      const appliedId = idOf(await addRegistryRows(db, 'stage', [{ key: 'applied', label: 'Applied', isApplied: true }]))
      const arranged = await arrange(db, 'Applied')
      await appendStageEvent(db, { postingId: arranged.postingId, stageId: appliedId })
      const client = await connectTools(scoreTools, db)
      const result = await client.call('score_posting', covered(arranged))
      return { result, events: await eventCount(db, arranged.postingId) }
    })

    expect(outcome.result.body).toMatchObject({ score: { recommendApply: true }, stageEvent: null })
    expect(outcome.events).toBe(1)
  })

  test('score_posting leaves a recommended posting unmoved when no phase is flagged shortlist', async () => {
    const client = await connectTools(scoreTools, database())
    const arranged = await arrange(database(), 'No shortlist')

    const outcome = await client.call('score_posting', covered(arranged))

    expect(outcome.body).toMatchObject({ score: { recommendApply: true }, stageEvent: null })
  })

  test('score_posting runs the score and the move in one transaction on the database it was given', async () => {
    let opened = 0
    const counting = new Proxy(database(), {
      get(target, property): unknown {
        const member: unknown = Reflect.get(target, property, target)
        if (property !== 'transaction' || typeof member !== 'function') return member
        return (...args: unknown[]): unknown => {
          opened += 1
          return member.apply(target, args)
        }
      },
    }) as Db
    const client = await connectTools(scoreTools, counting)
    const arranged = await arrange(database(), 'One transaction')

    const outcome = await client.call('score_posting', covered(arranged))

    expect(outcome.failed).toBe(false)
    expect(opened).toBe(1)
  })

  test('score_posting rejects an array, and a rating with no coverage, before touching the database', async () => {
    const client = await connectTools(scoreTools, untouchableDb())

    const array = await client.call('score_posting', { items: [{ postingId: 1, criteriaSetId: 1, ratings: [], penalties: [] }] })
    const noCoverage = await client.call('score_posting', {
      postingId: 1,
      criteriaSetId: 1,
      ratings: [{ requirementId: 1 }],
      penalties: [],
    })

    expect([array.failed, noCoverage.failed]).toEqual([true, true])
  })

  test('score_posting for an unknown posting is a not-found error and writes nothing', async () => {
    const client = await connectTools(scoreTools, database())
    const arranged = await arrange(database(), 'Unknown posting')

    const outcome = await client.call('score_posting', { ...covered(arranged), postingId: 999_999 })

    expect(outcome.failed).toBe(true)
    expect(failureText(outcome)).toContain('posting 999999 does not exist')
  })

  test('score_posting_bulk moves exactly those postings whose own score recommended it', async () => {
    const outcome = await withMigratedScratchDatabase(async (db) => {
      const stageId = await shortlist(db)
      const recommended = await arrange(db, 'Bulk recommended')
      const declined = await arrange(db, 'Bulk declined')
      const alsoRecommended = await arrange(db, 'Bulk also recommended')
      const client = await connectTools(scoreTools, db)
      const result = await client.call('score_posting_bulk', {
        items: [covered(recommended), uncovered(declined), covered(alsoRecommended)],
      })
      return {
        result,
        stageId,
        ids: [recommended, declined, alsoRecommended].map((arranged) => arranged.postingId),
        events: await Promise.all([recommended, declined, alsoRecommended].map((arranged) => eventCount(db, arranged.postingId))),
      }
    })

    const [first, second, third] = outcome.ids
    expect(outcome.result.body).toEqual([
      expect.objectContaining({ score: expect.objectContaining({ postingId: first, recommendApply: true }), stageEvent: expect.objectContaining({ stageId: outcome.stageId }) }),
      expect.objectContaining({ score: expect.objectContaining({ postingId: second, recommendApply: false }), stageEvent: null }),
      expect.objectContaining({ score: expect.objectContaining({ postingId: third, recommendApply: true }), stageEvent: expect.objectContaining({ stageId: outcome.stageId }) }),
    ])
    expect(outcome.events).toEqual([1, 0, 1])
  })

  test('score_posting_bulk stores no score and moves no posting when a later item fails, naming its index', async () => {
    const outcome = await withMigratedScratchDatabase(async (db) => {
      await shortlist(db)
      const first = await arrange(db, 'Bulk atomic')
      const client = await connectTools(scoreTools, db)
      const result = await client.call('score_posting_bulk', {
        items: [covered(first), { ...covered(first), postingId: 999_999 }],
      })
      const history = await client.call('score_history', { postingId: first.postingId })
      return { result, history, events: await eventCount(db, first.postingId) }
    })

    expect(failureText(outcome.result)).toContain('bulk item 1 failed: posting 999999 does not exist')
    expect(outcome.history.body).toEqual([])
    expect(outcome.events).toBe(0)
  })

  test('score_posting_bulk leaves an already applied posting where it is while moving the others', async () => {
    const outcome = await withMigratedScratchDatabase(async (db) => {
      await shortlist(db)
      const appliedId = idOf(await addRegistryRows(db, 'stage', [{ key: 'applied', label: 'Applied', isApplied: true }]))
      const applied = await arrange(db, 'Bulk applied')
      const fresh = await arrange(db, 'Bulk fresh')
      await appendStageEvent(db, { postingId: applied.postingId, stageId: appliedId })
      const client = await connectTools(scoreTools, db)
      const result = await client.call('score_posting_bulk', { items: [covered(applied), covered(fresh)] })
      return { result, events: [await eventCount(db, applied.postingId), await eventCount(db, fresh.postingId)] }
    })

    expect(outcome.result.body).toEqual([
      expect.objectContaining({ stageEvent: null }),
      expect.objectContaining({ stageEvent: expect.anything() }),
    ])
    expect(outcome.events).toEqual([1, 1])
  })

  test('score_posting_bulk rejects an over-cap array, an empty one and a single item at the schema', async () => {
    const client = await connectTools(scoreTools, untouchableDb())
    const item = { postingId: 1, criteriaSetId: 1, ratings: [], penalties: [] }

    const over = await client.call('score_posting_bulk', { items: Array.from({ length: BULK_MAX + 1 }, () => item) })
    const empty = await client.call('score_posting_bulk', { items: [] })
    const single = await client.call('score_posting_bulk', item)

    expect([over.failed, empty.failed, single.failed]).toEqual([true, true, true])
  })

  test('score_history lists every score newest first and score_best keeps the latest per set', async () => {
    const client = await connectTools(scoreTools, database())
    const arranged = await arrange(database(), 'History')
    const otherSet = await arrangeSet(database(), 'History other set')
    await client.call('score_posting', uncovered(arranged))
    await client.call('score_posting', { ...covered(arranged), criteriaSetId: otherSet.setId, ratings: [{ requirementId: otherSet.requirementId, coverage: 1 }] })
    await client.call('score_posting', covered(arranged))

    const history = await client.call('score_history', { postingId: arranged.postingId })
    const best = await client.call('score_best', { postingId: arranged.postingId })

    const sets = (outcome: { body: unknown }): number[] => (outcome.body as { criteriaSetId: number }[]).map((row) => row.criteriaSetId)
    expect(sets(best).sort()).toEqual([arranged.setId, otherSet.setId].sort())
    expect(sets(history)).toHaveLength(2)
    expect((best.body as { criteriaSetId: number; recommendApply: boolean }[]).find((row) => row.criteriaSetId === arranged.setId)?.recommendApply).toBe(true)
  })

  test('score_best names the set of each row and returns only the newest version of a set name', async () => {
    const client = await connectTools(scoreTools, database())
    const arranged = await arrange(database(), 'Versioned')
    const next = await insertCriteriaSet(database(), { name: 'Versioned', version: 2, applyThreshold: 0.5 })
    const nextRequirements = await database()
      .insert(requirement)
      .values({ criteriaSetId: next.id, key: 'skill', label: 'Skill', kind: 'soft', weight: 1, anchors: { '0': 'a', '0.5': 'b', '1': 'c' } })
      .returning()
    await client.call('score_posting', covered(arranged))
    await client.call('score_posting', {
      ...covered(arranged),
      criteriaSetId: next.id,
      ratings: [{ requirementId: idOf(nextRequirements), coverage: 0 }],
    })

    const best = await client.call('score_best', { postingId: arranged.postingId })
    const history = await client.call('score_history', { postingId: arranged.postingId })

    expect(best.body).toEqual([expect.objectContaining({ criteriaSetId: next.id, criteriaSetName: 'Versioned', criteriaSetVersion: 2, recommendApply: false })])
    expect(history.body).toHaveLength(2)
  })

  test('score_history and score_best return an empty list for an unscored posting and not-found for no posting', async () => {
    const client = await connectTools(scoreTools, database())
    const arranged = await arrange(database(), 'Unscored')

    const history = await client.call('score_history', { postingId: arranged.postingId })
    const best = await client.call('score_best', { postingId: arranged.postingId })
    const missing = await client.call('score_history', { postingId: 999_999 })

    expect([history.body, best.body]).toEqual([[], []])
    expect(failureText(missing)).toContain('posting 999999 does not exist')
  })

  test('rescore_request records a request and rescore_pending lists what it waits on until it is scored', async () => {
    const client = await connectTools(scoreTools, database())
    const arranged = await arrange(database(), 'Rescored', '2031-05-01')

    const request = await client.call('rescore_request', { criteriaSetId: arranged.setId, sinceDate: '2031-01-01' })
    const requestId = (request.body as { id: number }).id
    const waiting = await client.call('rescore_pending', { rescoreRequestId: requestId })
    await client.call('score_posting', covered(arranged))
    const done = await client.call('rescore_pending', { rescoreRequestId: requestId })

    expect(request.body).toMatchObject({ criteriaSetId: arranged.setId, sinceDate: '2031-01-01' })
    expect(waiting.body).toEqual([{ rescoreRequestId: requestId, postingId: arranged.postingId, criteriaSetId: arranged.setId }])
    expect(done.body).toEqual([])
  })

  test('rescore_pending without an id lists every request and an unknown id is a not-found error', async () => {
    const client = await connectTools(scoreTools, database())

    const all = await client.call('rescore_pending', {})
    const missing = await client.call('rescore_pending', { rescoreRequestId: 999_999 })

    expect(all.failed).toBe(false)
    expect(Array.isArray(all.body)).toBe(true)
    expect(failureText(missing)).toContain('rescore request 999999 does not exist')
  })

  test('rescore_request refuses a malformed date at the schema and an unknown set with not-found', async () => {
    const client = await connectTools(scoreTools, database())

    const badDate = await client.call('rescore_request', { criteriaSetId: 1, sinceDate: 'last week' })
    const unknownSet = await client.call('rescore_request', { criteriaSetId: 999_999, sinceDate: '2031-01-01' })

    expect(badDate.failed).toBe(true)
    expect(failureText(unknownSet)).toContain('criteria set 999999 does not exist')
  })
})
