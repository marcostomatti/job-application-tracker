import { eq } from 'drizzle-orm'

import { NotFoundError } from '../../errors.ts'
import { posting } from '../schema/postings.ts'
import type { Db } from './db.ts'

/**
 * Refuses a posting id with no posting, so "no such posting" and "nothing stored for it yet"
 * stay different answers, and a write never meets a foreign-key error instead.
 */
export async function assertPostingExists(db: Db, postingId: number): Promise<void> {
  const [found] = await db.select({ id: posting.id }).from(posting).where(eq(posting.id, postingId))
  if (!found) throw new NotFoundError('posting', postingId)
}
