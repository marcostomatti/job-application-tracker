import { eq, sql, type InferSelectModel } from 'drizzle-orm'

import { NotFoundError } from '../../errors.ts'
import type { SummaryInput } from '../../schemas/summaries.ts'
import { posting, postingSummary } from '../schema/postings.ts'
import type { Db } from './db.ts'

export type PostingSummary = InferSelectModel<typeof postingSummary>

/** Refuses a posting id with no posting, so a summary is never written to or read for nothing. */
async function assertPostingExists(db: Db, postingId: number): Promise<void> {
  const [found] = await db.select({ id: posting.id }).from(posting).where(eq(posting.id, postingId))
  if (!found) throw new NotFoundError('posting', postingId)
}

/**
 * The stored summary of a posting that is known to exist, or null when none was written.
 * `getPosting` uses it directly; a caller that has only an id uses `getSummary`.
 */
export async function findSummary(db: Db, postingId: number): Promise<PostingSummary | null> {
  const [found] = await db.select().from(postingSummary).where(eq(postingSummary.postingId, postingId))
  return found ?? null
}

/**
 * Writes the summary of a posting, replacing any earlier one in full, and returns it as
 * stored. A repost is this same call with a new `sourceHash`: the posting stays one row and
 * its summary stays one row. Fields the input leaves out are cleared rather than kept, so
 * nothing from the older posting survives beside the newer text, and `summarisedAt` moves.
 *
 * `summarisedAt` is stamped with the database's `now()`, the clock every sibling timestamp
 * column already uses through `defaultNow()`; a column default does not run on the update
 * half of an upsert, so it is set explicitly, and by the same clock. An application-side
 * `new Date()` here would mix two clocks in one table family. `now()` is the start of the
 * transaction, so two writes inside one transaction carry one stamp.
 */
export async function writeSummary(db: Db, input: SummaryInput): Promise<PostingSummary> {
  await assertPostingExists(db, input.postingId)
  const values = {
    postingId: input.postingId,
    stack: input.stack ?? [],
    description: input.description ?? null,
    industry: input.industry ?? null,
    condensed: input.condensed,
    extra: input.extra ?? {},
    sourceHash: input.sourceHash,
    summarisedAt: sql`now()`,
  }
  const [written] = await db
    .insert(postingSummary)
    .values(values)
    .onConflictDoUpdate({ target: postingSummary.postingId, set: values })
    .returning()
  if (!written) throw new NotFoundError('posting', input.postingId)
  return written
}

/**
 * The summary of a posting, or null when the posting exists and has none yet. A posting
 * that does not exist is `NotFoundError`, so a caller can tell "nothing summarised" from "no
 * such posting"; the second check runs only when no summary was found.
 */
export async function getSummary(db: Db, postingId: number): Promise<PostingSummary | null> {
  const found = await findSummary(db, postingId)
  if (found) return found
  await assertPostingExists(db, postingId)
  return null
}

/**
 * Whether the posting changed since the summary was written: true when `sourceHash` differs
 * from the stored one, or when no summary is stored, because then there is nothing it matches
 * and the caller has a summary to write. This is the one implementation behind "did the
 * posting change"; no second tool exposes it. A posting that does not exist is
 * `NotFoundError`.
 */
export async function summaryChanged(db: Db, postingId: number, sourceHash: string): Promise<boolean> {
  const [stored] = await db
    .select({ sourceHash: postingSummary.sourceHash })
    .from(postingSummary)
    .where(eq(postingSummary.postingId, postingId))
  if (stored) return stored.sourceHash !== sourceHash
  await assertPostingExists(db, postingId)
  return true
}
