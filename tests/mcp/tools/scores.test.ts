import { describe, expect, test } from 'bun:test'
import { count, eq } from 'drizzle-orm'

import type { DrizzleClient } from '../../../src/data/client.ts'
import type { Db } from '../../../src/data/repositories/db.ts'
import { appendStageEvent } from '../../../src/data/repositories/dispositions.ts'
import { addPositions } from '../../../src/data/repositories/positions.ts'
import { addRegistryRows } from '../../../src/data/repositories/registries.ts'
import { positionStageEvent } from '../../../src/data/schema/dispositions.ts'
import { scoreTools } from '../../../src/mcp/tools/scores.ts'
import { withMigratedScratchDatabase } from '../../data/scratch-database.ts'
import { arrangeSet } from './criteria-arrangement.ts'
import { connectTools, failureText, idOf, untouchableDb, useSharedScratchDatabase } from './harness.ts'

const database = useSharedScratchDatabase()

type Arranged = { positionId: number; setId: number; requirementId: number }

async function arrange(db: DrizzleClient, name: string, seenAt = '2026-06-01'): Promise<Arranged> {
  const positionId = idOf(await addPositions(db, [{ company: { name: `${name} Co` }, roleTitle: name, seenAt }]))
  return { positionId, ...(await arrangeSet(db, name)) }
}

/** A score that clears the set's 0.5 bar, because its one requirement is fully covered. */
const covered = (arranged: Arranged): Record<string, unknown> => ({
  positionId: arranged.positionId,
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

async function eventCount(db: DrizzleClient, positionId: number): Promise<number> {
  const [found] = await db.select({ n: count() }).from(positionStageEvent).where(eq(positionStageEvent.positionId, positionId))
  return found?.n ?? 0
}

describe('the scores group', () => {
  test('the scores group registers exactly the named tools', () => {
    expect(scoreTools.map((tool) => tool.name).sort()).toEqual([
      'rescore_pending',
      'rescore_request',
      'score_best',
      'score_history',
      'score_position',
    ])
  })

  test('no tool sets annotations, which are left for the author to decide', () => {
    expect(scoreTools.filter((tool) => tool.annotations !== undefined)).toEqual([])
  })

  test('score_position stores the score and reports no stage event when none was due', async () => {
    const client = await connectTools(scoreTools, database())
    const arranged = await arrange(database(), 'Stored')

    const outcome = await client.call('score_position', uncovered(arranged))

    expect(outcome.failed).toBe(false)
    expect(outcome.body).toMatchObject({
      score: { positionId: arranged.positionId, recommendApply: false, limiterKey: 'skill' },
      stageEvent: null,
    })
  })

  test('score_position moves a newly recommended position to the shortlist phase', async () => {
    const outcome = await withMigratedScratchDatabase(async (db) => {
      const stageId = await shortlist(db)
      const arranged = await arrange(db, 'Moved')
      const client = await connectTools(scoreTools, db)
      const result = await client.call('score_position', covered(arranged))
      return { result, stageId, positionId: arranged.positionId, events: await eventCount(db, arranged.positionId) }
    })

    expect(outcome.result.body).toMatchObject({
      score: { recommendApply: true },
      stageEvent: { positionId: outcome.positionId, stageId: outcome.stageId },
    })
    expect(outcome.events).toBe(1)
  })

  test('score_position leaves an already applied position where it is', async () => {
    const outcome = await withMigratedScratchDatabase(async (db) => {
      await shortlist(db)
      const appliedId = idOf(await addRegistryRows(db, 'stage', [{ key: 'applied', label: 'Applied', isApplied: true }]))
      const arranged = await arrange(db, 'Applied')
      await appendStageEvent(db, { positionId: arranged.positionId, stageId: appliedId })
      const client = await connectTools(scoreTools, db)
      const result = await client.call('score_position', covered(arranged))
      return { result, events: await eventCount(db, arranged.positionId) }
    })

    expect(outcome.result.body).toMatchObject({ score: { recommendApply: true }, stageEvent: null })
    expect(outcome.events).toBe(1)
  })

  test('score_position leaves a recommended position unmoved when no phase is flagged shortlist', async () => {
    const client = await connectTools(scoreTools, database())
    const arranged = await arrange(database(), 'No shortlist')

    const outcome = await client.call('score_position', covered(arranged))

    expect(outcome.body).toMatchObject({ score: { recommendApply: true }, stageEvent: null })
  })

  test('score_position runs the score and the move in one transaction on the database it was given', async () => {
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

    await client.call('score_position', covered(arranged))

    expect(opened).toBe(1)
  })

  test('score_position rejects an array, and a rating with no coverage, before touching the database', async () => {
    const client = await connectTools(scoreTools, untouchableDb())

    const array = await client.call('score_position', { items: [{ positionId: 1, criteriaSetId: 1, ratings: [], penalties: [] }] })
    const noCoverage = await client.call('score_position', {
      positionId: 1,
      criteriaSetId: 1,
      ratings: [{ requirementId: 1 }],
      penalties: [],
    })

    expect([array.failed, noCoverage.failed]).toEqual([true, true])
  })

  test('score_position for an unknown position is a not-found error and writes nothing', async () => {
    const client = await connectTools(scoreTools, database())
    const arranged = await arrange(database(), 'Unknown position')

    const outcome = await client.call('score_position', { ...covered(arranged), positionId: 999_999 })

    expect(outcome.failed).toBe(true)
    expect(failureText(outcome)).toContain('position 999999 does not exist')
  })

  test('score_history lists every score newest first and score_best keeps the latest per set', async () => {
    const client = await connectTools(scoreTools, database())
    const arranged = await arrange(database(), 'History')
    const otherSet = await arrangeSet(database(), 'History other set')
    await client.call('score_position', uncovered(arranged))
    await client.call('score_position', { ...covered(arranged), criteriaSetId: otherSet.setId, ratings: [{ requirementId: otherSet.requirementId, coverage: 1 }] })
    await client.call('score_position', covered(arranged))

    const history = await client.call('score_history', { positionId: arranged.positionId })
    const best = await client.call('score_best', { positionId: arranged.positionId })

    const sets = (outcome: { body: unknown }): number[] => (outcome.body as { criteriaSetId: number }[]).map((row) => row.criteriaSetId)
    expect(sets(best).sort()).toEqual([arranged.setId, otherSet.setId].sort())
    expect(sets(history)).toHaveLength(2)
    expect((best.body as { criteriaSetId: number; recommendApply: boolean }[]).find((row) => row.criteriaSetId === arranged.setId)?.recommendApply).toBe(true)
  })

  test('score_history and score_best return an empty list for an unscored position and not-found for no position', async () => {
    const client = await connectTools(scoreTools, database())
    const arranged = await arrange(database(), 'Unscored')

    const history = await client.call('score_history', { positionId: arranged.positionId })
    const best = await client.call('score_best', { positionId: arranged.positionId })
    const missing = await client.call('score_history', { positionId: 999_999 })

    expect([history.body, best.body]).toEqual([[], []])
    expect(failureText(missing)).toContain('position 999999 does not exist')
  })

  test('rescore_request records a request and rescore_pending lists what it waits on until it is scored', async () => {
    const client = await connectTools(scoreTools, database())
    const arranged = await arrange(database(), 'Rescored', '2031-05-01')

    const request = await client.call('rescore_request', { criteriaSetId: arranged.setId, sinceDate: '2031-01-01' })
    const requestId = (request.body as { id: number }).id
    const waiting = await client.call('rescore_pending', { rescoreRequestId: requestId })
    await client.call('score_position', covered(arranged))
    const done = await client.call('rescore_pending', { rescoreRequestId: requestId })

    expect(request.body).toMatchObject({ criteriaSetId: arranged.setId, sinceDate: '2031-01-01' })
    expect(waiting.body).toEqual([{ rescoreRequestId: requestId, positionId: arranged.positionId, criteriaSetId: arranged.setId }])
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
