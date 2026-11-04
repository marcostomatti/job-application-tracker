import { eq } from 'drizzle-orm'

import { NotFoundError } from '../../errors.ts'
import { posting } from '../schema/postings.ts'
import type { Db } from './db.ts'

/**
 * The `posting_key` of one posting, which is how a notebook source names the posting it holds.
 * A read and nothing else: no notebook tool writes to the tracker.
 */
export async function findPostingKey(db: Db, postingId: number): Promise<string> {
  const [found] = await db.select({ postingKey: posting.postingKey }).from(posting).where(eq(posting.id, postingId))
  if (!found) throw new NotFoundError('posting', postingId)
  return found.postingKey
}
