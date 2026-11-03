import { eq, type InferSelectModel } from 'drizzle-orm'

import { NotFoundError } from '../../errors.ts'
import type { SummaryInput } from '../../schemas/summaries.ts'
import { position, positionSummary } from '../schema/positions.ts'
import type { Db } from './db.ts'

export type PositionSummary = InferSelectModel<typeof positionSummary>

/** Refuses a position id with no position, so a summary is never written to or read for nothing. */
async function assertPositionExists(db: Db, positionId: number): Promise<void> {
  const [found] = await db.select({ id: position.id }).from(position).where(eq(position.id, positionId))
  if (!found) throw new NotFoundError('position', positionId)
}

/**
 * The stored summary of a position that is known to exist, or null when none was written.
 * `getPosition` uses it directly; a caller that has only an id uses `getSummary`.
 */
export async function findSummary(db: Db, positionId: number): Promise<PositionSummary | null> {
  const [found] = await db.select().from(positionSummary).where(eq(positionSummary.positionId, positionId))
  return found ?? null
}

/**
 * Writes the summary of a position, replacing any earlier one in full, and returns it as
 * stored. A repost is this same call with a new `sourceHash`: the position stays one row and
 * its summary stays one row. Fields the input leaves out are cleared rather than kept, so
 * nothing from the older posting survives beside the newer text, and `summarisedAt` moves.
 */
export async function writeSummary(db: Db, input: SummaryInput): Promise<PositionSummary> {
  await assertPositionExists(db, input.positionId)
  const values = {
    positionId: input.positionId,
    stack: input.stack ?? [],
    description: input.description ?? null,
    industry: input.industry ?? null,
    condensed: input.condensed,
    extra: input.extra ?? {},
    sourceHash: input.sourceHash,
    summarisedAt: new Date(),
  }
  const [written] = await db
    .insert(positionSummary)
    .values(values)
    .onConflictDoUpdate({ target: positionSummary.positionId, set: values })
    .returning()
  if (!written) throw new NotFoundError('position', input.positionId)
  return written
}

/**
 * The summary of a position, or null when the position exists and has none yet. A position
 * that does not exist is `NotFoundError`, so a caller can tell "nothing summarised" from "no
 * such position"; the second check runs only when no summary was found.
 */
export async function getSummary(db: Db, positionId: number): Promise<PositionSummary | null> {
  const found = await findSummary(db, positionId)
  if (found) return found
  await assertPositionExists(db, positionId)
  return null
}

/**
 * Whether the posting changed since the summary was written: true when `sourceHash` differs
 * from the stored one, or when no summary is stored, because then there is nothing it matches
 * and the caller has a summary to write. This is the one implementation behind "did the
 * posting change"; no second tool exposes it. A position that does not exist is
 * `NotFoundError`.
 */
export async function summaryChanged(db: Db, positionId: number, sourceHash: string): Promise<boolean> {
  const [stored] = await db
    .select({ sourceHash: positionSummary.sourceHash })
    .from(positionSummary)
    .where(eq(positionSummary.positionId, positionId))
  if (stored) return stored.sourceHash !== sourceHash
  await assertPositionExists(db, positionId)
  return true
}
