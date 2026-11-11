import { afterAll, describe, expect, test } from 'bun:test'
import { and, asc, eq, inArray } from 'drizzle-orm'

import { closeDb } from '../../src/data/client.ts'
import { criteriaSet } from '../../src/data/schema/criteria.ts'
import { appConfig, pendingRescore, rescoreRequest } from '../../src/data/schema/config.ts'
import { company, normaliseName, posting } from '../../src/data/schema/postings.ts'
import { postingScore } from '../../src/data/schema/scores.ts'
import { rolledBack, type Tx } from './rolled-back.ts'

const SINCE = '2026-03-10'
const BEFORE_SINCE = '2026-03-09'
const AFTER_SINCE = '2026-03-11'

afterAll(async () => {
  await closeDb()
})

async function addCriteriaSet(tx: Tx, token: string, name: string): Promise<number> {
  const [row] = await tx.insert(criteriaSet).values({ name: `${name} ${token}` }).returning()
  return row!.id
}

/** A posting first seen on `seenAt`; the company is created alongside it. */
async function addPosting(tx: Tx, token: string, name: string, seenAt: string): Promise<number> {
  const [owner] = await tx
    .insert(company)
    .values({ name: `${name} ${token}`, nameNorm: normaliseName(`${name} ${token}`) })
    .returning()
  const [target] = await tx
    .insert(posting)
    .values({
      postingKey: `${name}-${token}`,
      companyId: owner!.id,
      roleTitle: 'Staff Engineer',
      roleNorm: normaliseName('Staff Engineer'),
      seenAt,
    })
    .returning()
  return target!.id
}

async function addRequest(tx: Tx, criteriaSetId: number, sinceDate: string): Promise<number> {
  const [row] = await tx.insert(rescoreRequest).values({ criteriaSetId, sinceDate }).returning()
  return row!.id
}

/**
 * The posting ids the view lists for one request, in a stable order, limited to postings the
 * test created. The view joins a request to every posting seen on or after its date, so a
 * posting committed to the shared database would otherwise show up as pending too.
 */
async function pendingFor(tx: Tx, requestId: number, createdIds: number[]): Promise<number[]> {
  const rows = await tx
    .select()
    .from(pendingRescore)
    .where(and(eq(pendingRescore.rescoreRequestId, requestId), inArray(pendingRescore.postingId, createdIds)))
    .orderBy(asc(pendingRescore.postingId))
  return rows.map((row) => row.postingId)
}

/** Ids in ascending order, the order `pendingFor` returns them in. */
function ascending(ids: number[]): number[] {
  return [...ids].sort((a, b) => a - b)
}

describe('app config and the pending re-score view', () => {
  test('app_config stores the criteria mode', async () => {
    // Arrange / Act
    const { versioned, perspective, structured } = await rolledBack(async (tx) => {
      const write = async (value: unknown) => {
        await tx
          .insert(appConfig)
          .values({ key: 'criteria_mode', value })
          .onConflictDoUpdate({ target: appConfig.key, set: { value } })
        const [row] = await tx.select().from(appConfig).where(eq(appConfig.key, 'criteria_mode'))
        return row
      }
      return {
        versioned: await write('versioned'),
        perspective: await write('perspective'),
        // No CHECK sits on the value: a number or an object is stored as readily as a string
        structured: await Promise.all(
          [42, { mode: 'perspective', weights: [1, 2] }].map(async (value, index) => {
            const key = `shape_${index}`
            await tx.insert(appConfig).values({ key, value })
            const [row] = await tx.select().from(appConfig).where(eq(appConfig.key, key))
            return row
          }),
        ),
      }
    })

    // Assert: each value comes back as stored, and a second write to a key replaces the first
    expect(versioned?.value).toBe('versioned')
    expect(perspective?.value).toBe('perspective')
    expect(structured.map((row) => row?.value)).toEqual([42, { mode: 'perspective', weights: [1, 2] }])
  })

  test('pending_rescore lists postings seen on or after since_date with no score for the set', async () => {
    // Arrange / Act
    const { pending, onSince, afterSince } = await rolledBack(async (tx, token) => {
      const setId = await addCriteriaSet(tx, token, 'Set A')
      const requestId = await addRequest(tx, setId, SINCE)
      const onSince = await addPosting(tx, token, 'on-since', SINCE)
      const afterSince = await addPosting(tx, token, 'after-since', AFTER_SINCE)
      return { pending: await pendingFor(tx, requestId, [onSince, afterSince]), onSince, afterSince }
    })

    // Assert: the boundary day counts, and so does a later day
    expect(pending).toEqual([onSince, afterSince])
  })

  test('pending_rescore excludes a posting already scored against that set', async () => {
    // Arrange / Act
    const { pending, unscored, scoredElsewhere } = await rolledBack(async (tx, token) => {
      const setId = await addCriteriaSet(tx, token, 'Set A')
      const otherSetId = await addCriteriaSet(tx, token, 'Set B')
      const requestId = await addRequest(tx, setId, SINCE)
      const scored = await addPosting(tx, token, 'scored', AFTER_SINCE)
      const unscored = await addPosting(tx, token, 'unscored', AFTER_SINCE)
      const scoredElsewhere = await addPosting(tx, token, 'scored-elsewhere', AFTER_SINCE)
      await tx.insert(postingScore).values([
        { postingId: scored, criteriaSetId: setId },
        { postingId: scoredElsewhere, criteriaSetId: otherSetId },
      ])
      return { pending: await pendingFor(tx, requestId, [scored, unscored, scoredElsewhere]), unscored, scoredElsewhere }
    })

    // Assert: only a score for this request's set removes a posting; a score for another set does not
    expect(pending).toEqual(ascending([unscored, scoredElsewhere]))
  })

  test('pending_rescore excludes a posting seen before since_date', async () => {
    // Arrange / Act
    const { pending, recent } = await rolledBack(async (tx, token) => {
      const setId = await addCriteriaSet(tx, token, 'Set A')
      const requestId = await addRequest(tx, setId, SINCE)
      const old = await addPosting(tx, token, 'old', BEFORE_SINCE)
      const recent = await addPosting(tx, token, 'recent', SINCE)
      return { pending: await pendingFor(tx, requestId, [old, recent]), recent }
    })

    // Assert: the day before since_date is out, the day itself is in
    expect(pending).toEqual([recent])
  })

  test('scoring a pending posting removes it from the view without an update', async () => {
    // Arrange / Act: nothing but the score insert happens between the two reads
    const { before, after, other, requestRow, requestRowAfter } = await rolledBack(async (tx, token) => {
      const setId = await addCriteriaSet(tx, token, 'Set A')
      const requestId = await addRequest(tx, setId, SINCE)
      const target = await addPosting(tx, token, 'target', AFTER_SINCE)
      const other = await addPosting(tx, token, 'other', AFTER_SINCE)
      const created = [target, other]
      const before = await pendingFor(tx, requestId, created)
      const [requestRow] = await tx.select().from(rescoreRequest).where(eq(rescoreRequest.id, requestId))
      await tx.insert(postingScore).values({ postingId: target, criteriaSetId: setId })
      const after = await pendingFor(tx, requestId, created)
      const [requestRowAfter] = await tx.select().from(rescoreRequest).where(eq(rescoreRequest.id, requestId))
      return { before: { ids: before, target }, after, other, requestRow, requestRowAfter }
    })

    // Assert: the scored posting leaves, the other stays, and the request row itself is untouched
    expect(before.ids).toEqual(ascending([before.target, other]))
    expect(after).toEqual([other])
    expect(requestRowAfter).toEqual(requestRow)
  })

  test('each request lists only its own postings and judges them against its own set', async () => {
    // Arrange / Act: two requests on two sets, both reaching the same postings by date
    const result = await rolledBack(async (tx, token) => {
      const setA = await addCriteriaSet(tx, token, 'Set A')
      const setB = await addCriteriaSet(tx, token, 'Set B')
      const requestA = await addRequest(tx, setA, SINCE)
      const requestB = await addRequest(tx, setB, AFTER_SINCE)
      const scoredForA = await addPosting(tx, token, 'scored-for-a', AFTER_SINCE)
      const scoredForB = await addPosting(tx, token, 'scored-for-b', AFTER_SINCE)
      const neither = await addPosting(tx, token, 'neither', AFTER_SINCE)
      const onlyReachedByA = await addPosting(tx, token, 'only-reached-by-a', SINCE)
      await tx.insert(postingScore).values([
        { postingId: scoredForA, criteriaSetId: setA },
        { postingId: scoredForB, criteriaSetId: setB },
      ])
      const created = [scoredForA, scoredForB, neither, onlyReachedByA]
      return {
        forA: await pendingFor(tx, requestA, created),
        forB: await pendingFor(tx, requestB, created),
        scoredForA,
        scoredForB,
        neither,
        onlyReachedByA,
      }
    })

    // Assert: a score for one request's set clears that request only, and the date is each request's own
    expect(result.forA).toEqual(ascending([result.scoredForB, result.neither, result.onlyReachedByA]))
    expect(result.forB).toEqual(ascending([result.scoredForA, result.neither]))
  })
})
