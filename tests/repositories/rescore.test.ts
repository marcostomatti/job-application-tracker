import { describe, expect, test } from 'bun:test'
import type { DrizzleClient } from '../../src/data/client.ts'
import { addPostings } from '../../src/data/repositories/postings.ts'
import { listPendingRescore, requestRescore } from '../../src/data/repositories/rescore.ts'
import { scorePosting } from '../../src/data/repositories/scores.ts'
import { insertCriteriaSet, requirement } from '../../src/data/schema/criteria.ts'
import { NotFoundError } from '../../src/errors.ts'
import { PendingRescoreQuerySchema, RescoreRequestInputSchema } from '../../src/schemas/scores.ts'
import { thrownBy } from '../data/rolled-back.ts'
import { withMigratedScratchDatabase } from '../data/scratch-database.ts'

const ANCHORS = { '0': 'nothing', '0.5': 'some', '1': 'everything' }
const SINCE = '2026-03-10'
const BEFORE_SINCE = '2026-03-09'
const AFTER_SINCE = '2026-03-11'

type Arranged = {
  readonly setId: number
  readonly otherSetId: number
  readonly requirementId: number
  readonly otherRequirementId: number
  readonly early: number
  readonly late: number
}

/** The id at `index`, or a loud failure: an absent row would otherwise read as a pass. */
function idOf(rows: readonly { readonly id: number }[], index = 0): number {
  const id = rows[index]?.id
  if (id === undefined) throw new Error(`the arrangement produced no row at index ${index}`)
  return id
}

/** Two sets with one requirement each, and two postings: one seen before `SINCE`, one after. */
async function arrange(db: DrizzleClient): Promise<Arranged> {
  const postings = await addPostings(db, [
    { company: { name: 'Early Co' }, roleTitle: 'Engineer', seenAt: BEFORE_SINCE },
    { company: { name: 'Late Co' }, roleTitle: 'Engineer', seenAt: AFTER_SINCE },
  ])
  const set = await insertCriteriaSet(db, { name: 'Mine' })
  const otherSet = await insertCriteriaSet(db, { name: 'Theirs' })
  const rows = await db
    .insert(requirement)
    .values([
      { criteriaSetId: set.id, key: 'a', label: 'A', weight: 1, anchors: ANCHORS },
      { criteriaSetId: otherSet.id, key: 'b', label: 'B', weight: 1, anchors: ANCHORS },
    ])
    .returning()
  return {
    setId: set.id,
    otherSetId: otherSet.id,
    requirementId: idOf(rows, 0),
    otherRequirementId: idOf(rows, 1),
    early: idOf(postings, 0),
    late: idOf(postings, 1),
  }
}

describe('requestRescore', () => {
  test('stores the intent and returns the row, with no list of postings on it', async () => {
    // Arrange / Act
    const request = await withMigratedScratchDatabase(async (db) => {
      const arranged = await arrange(db)
      return requestRescore(db, { criteriaSetId: arranged.setId, sinceDate: SINCE })
    })

    // Assert
    expect(request).toMatchObject({ sinceDate: SINCE })
    expect(request.id).toBeGreaterThan(0)
    expect(request.requestedAt).toBeInstanceOf(Date)
    expect(Object.keys(request).sort()).toEqual(['criteriaSetId', 'id', 'requestedAt', 'sinceDate'])
  })

  test('refuses a criteria set that does not exist, with nothing stored', async () => {
    // Arrange / Act
    const { error, pending } = await withMigratedScratchDatabase(async (db) => {
      const error = await thrownBy(() => requestRescore(db, { criteriaSetId: 9999, sinceDate: SINCE }))
      return { error, pending: await listPendingRescore(db) }
    })

    // Assert
    expect(error).toBeInstanceOf(NotFoundError)
    expect(pending).toEqual([])
  })
})

describe('listPendingRescore', () => {
  test('lists the postings seen on or after the date, with the request and set they wait on', async () => {
    // Arrange / Act
    const { arranged, request, pending } = await withMigratedScratchDatabase(async (db) => {
      const arranged = await arrange(db)
      const request = await requestRescore(db, { criteriaSetId: arranged.setId, sinceDate: SINCE })
      return { arranged, request, pending: await listPendingRescore(db) }
    })

    // Assert: the posting seen before the date is not waiting
    expect(pending).toEqual([{ rescoreRequestId: request.id, postingId: arranged.late, criteriaSetId: arranged.setId }])
  })

  test('drops a posting as soon as it has a score for that set', async () => {
    // Arrange / Act
    const { arranged, before, after } = await withMigratedScratchDatabase(async (db) => {
      const arranged = await arrange(db)
      const request = await requestRescore(db, { criteriaSetId: arranged.setId, sinceDate: SINCE })
      const before = await listPendingRescore(db, request.id)
      await scorePosting(db, {
        postingId: arranged.late,
        criteriaSetId: arranged.setId,
        ratings: [{ requirementId: arranged.requirementId, coverage: 1, confidence: 'supported' }],
        penalties: [],
      })
      return { arranged, before, after: await listPendingRescore(db, request.id) }
    })

    // Assert
    expect(before.map((row) => row.postingId)).toEqual([arranged.late])
    expect(after).toEqual([])
  })

  test('ignores a score against a different set', async () => {
    // Arrange / Act
    const { arranged, pending } = await withMigratedScratchDatabase(async (db) => {
      const arranged = await arrange(db)
      const request = await requestRescore(db, { criteriaSetId: arranged.setId, sinceDate: SINCE })
      await scorePosting(db, {
        postingId: arranged.late,
        criteriaSetId: arranged.otherSetId,
        ratings: [{ requirementId: arranged.otherRequirementId, coverage: 1, confidence: 'supported' }],
        penalties: [],
      })
      return { arranged, pending: await listPendingRescore(db, request.id) }
    })

    // Assert
    expect(pending.map((row) => row.postingId)).toEqual([arranged.late])
  })

  test('narrows to one request, keeps the others apart, and lists in request then posting order', async () => {
    // Arrange / Act
    const { arranged, first, second, all, onlySecond } = await withMigratedScratchDatabase(async (db) => {
      const arranged = await arrange(db)
      const first = await requestRescore(db, { criteriaSetId: arranged.setId, sinceDate: SINCE })
      const second = await requestRescore(db, { criteriaSetId: arranged.otherSetId, sinceDate: BEFORE_SINCE })
      return {
        arranged,
        first,
        second,
        all: await listPendingRescore(db),
        onlySecond: await listPendingRescore(db, second.id),
      }
    })

    // Assert
    expect(all.map((row) => [row.rescoreRequestId, row.postingId])).toEqual([
      [first.id, arranged.late],
      [second.id, arranged.early],
      [second.id, arranged.late],
    ])
    expect(onlySecond.map((row) => row.criteriaSetId)).toEqual([arranged.otherSetId, arranged.otherSetId])
  })

  test('is empty when nothing is pending, and refuses a request that does not exist', async () => {
    // Arrange / Act
    const { none, noRequests, missing } = await withMigratedScratchDatabase(async (db) => {
      const arranged = await arrange(db)
      const noRequests = await listPendingRescore(db)
      const request = await requestRescore(db, { criteriaSetId: arranged.setId, sinceDate: '2999-01-01' })
      return {
        noRequests,
        none: await listPendingRescore(db, request.id),
        missing: await thrownBy(() => listPendingRescore(db, 9999)),
      }
    })

    // Assert: an empty list means nothing is waiting; an unknown request is a different answer
    expect(noRequests).toEqual([])
    expect(none).toEqual([])
    expect(missing).toBeInstanceOf(NotFoundError)
  })

  test('a posting already scored for the set when the request is made is not pending', async () => {
    // Arrange / Act
    const { pending } = await withMigratedScratchDatabase(async (db) => {
      const arranged = await arrange(db)
      await scorePosting(db, {
        postingId: arranged.late,
        criteriaSetId: arranged.setId,
        ratings: [{ requirementId: arranged.requirementId, coverage: 1, confidence: 'supported' }],
        penalties: [],
      })
      const request = await requestRescore(db, { criteriaSetId: arranged.setId, sinceDate: SINCE })
      return { pending: await listPendingRescore(db, request.id) }
    })

    // Assert: scored before the request existed, and still not waiting
    expect(pending).toEqual([])
  })
})

describe('the rescore schemas', () => {
  test('a request takes a set id and a calendar day, and refuses anything else', () => {
    expect(RescoreRequestInputSchema.parse({ criteriaSetId: '4', sinceDate: SINCE })).toEqual({ criteriaSetId: 4, sinceDate: SINCE })
    expect(RescoreRequestInputSchema.safeParse({ criteriaSetId: 4, sinceDate: '10/03/2026' }).success).toBe(false)
    expect(RescoreRequestInputSchema.safeParse({ criteriaSetId: 4, sinceDate: '2026-02-30' }).success).toBe(false)
    expect(RescoreRequestInputSchema.safeParse({ criteriaSetId: 4 }).success).toBe(false)
    expect(RescoreRequestInputSchema.safeParse({ criteriaSetId: 4, sinceDate: SINCE, extra: 1 }).success).toBe(false)
  })

  test('the pending query takes an optional request id and nothing else', () => {
    expect(PendingRescoreQuerySchema.parse({})).toEqual({})
    expect(PendingRescoreQuerySchema.parse({ rescoreRequestId: '3' })).toEqual({ rescoreRequestId: 3 })
    expect(PendingRescoreQuerySchema.safeParse({ rescoreRequestId: 0 }).success).toBe(false)
    expect(PendingRescoreQuerySchema.safeParse({ limit: 5 }).success).toBe(false)
  })
})
