import { asc, eq } from 'drizzle-orm'
import type { InferSelectModel } from 'drizzle-orm'

import { NotFoundError } from '../../errors.ts'
import type { RescoreRequestInput } from '../../schemas/scores.ts'
import { pendingRescore, rescoreRequest } from '../schema/config.ts'
import { findUsableCriteriaSet } from './criteria.ts'
import type { Db } from './db.ts'

export type RescoreRequest = InferSelectModel<typeof rescoreRequest>

/** One position still waiting on one request, with the set the request wants it scored against. */
export type PendingRescoreRow = {
  readonly rescoreRequestId: number
  readonly positionId: number
  readonly criteriaSetId: number
}

/**
 * Records that every position seen on or after `sinceDate` should be scored against a set.
 * Only the intent is stored; which positions are still waiting is read from the
 * `pending_rescore` view, so the request cannot drift from the scores. A set that does not exist is
 * `NotFoundError`, and an archived one is `ArchivedError`: a new request is a new use of the set.
 */
export async function requestRescore(db: Db, input: RescoreRequestInput): Promise<RescoreRequest> {
  await findUsableCriteriaSet(db, input.criteriaSetId)
  const [created] = await db
    .insert(rescoreRequest)
    .values({ criteriaSetId: input.criteriaSetId, sinceDate: input.sinceDate })
    .returning()
  if (!created) throw new Error('The rescore request insert returned no row.')
  return created
}

/**
 * The positions still waiting, read from the `pending_rescore` view and never from a stored
 * flag: scoring a position takes it out of the list with no update anywhere. Ordered by request,
 * then position, so a caller walking the list scores in a stable order. With a request id the
 * list is that request's, and a request that does not exist is `NotFoundError` rather than an
 * empty list, so "nothing waiting" and "no such request" stay different answers.
 */
export async function listPendingRescore(db: Db, rescoreRequestId?: number): Promise<PendingRescoreRow[]> {
  if (rescoreRequestId !== undefined) await assertRequestExists(db, rescoreRequestId)
  return db
    .select({
      rescoreRequestId: pendingRescore.rescoreRequestId,
      positionId: pendingRescore.positionId,
      criteriaSetId: rescoreRequest.criteriaSetId,
    })
    .from(pendingRescore)
    .innerJoin(rescoreRequest, eq(rescoreRequest.id, pendingRescore.rescoreRequestId))
    .where(rescoreRequestId === undefined ? undefined : eq(pendingRescore.rescoreRequestId, rescoreRequestId))
    .orderBy(asc(pendingRescore.rescoreRequestId), asc(pendingRescore.positionId))
}

async function assertRequestExists(db: Db, id: number): Promise<void> {
  const [found] = await db.select({ id: rescoreRequest.id }).from(rescoreRequest).where(eq(rescoreRequest.id, id))
  if (!found) throw new NotFoundError('rescore request', id)
}
