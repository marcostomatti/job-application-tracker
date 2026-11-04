import { and, eq, gte, sql } from 'drizzle-orm'
import { date, integer, jsonb, pgTable, pgView, text, timestamp } from 'drizzle-orm/pg-core'

import { criteriaSet } from './criteria.ts'
import { posting } from './postings.ts'
import { postingScore } from './scores.ts'

/**
 * App-level settings as key and JSON value. The criteria mode lives here under the key
 * `criteria_mode`, because it is one behaviour of the whole app and not a property of any one
 * criteria set. The value is jsonb with no CHECK on it, so which modes exist is decided by
 * the code that reads the key, and adding a mode never changes the table.
 */
export const appConfig = pgTable('app_config', {
  key: text().primaryKey(),
  value: jsonb().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * A request to score again: every posting seen on or after `since_date` should have a score
 * against `criteria_set_id`. The request stores only that intent. Which postings are still
 * waiting is derived by `pendingRescore`, never kept on the request, so it cannot drift.
 */
export const rescoreRequest = pgTable('rescore_request', {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  criteriaSetId: integer('criteria_set_id')
    .notNull()
    .references(() => criteriaSet.id),
  sinceDate: date('since_date', { mode: 'string' }).notNull(),
  requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * The postings still waiting for each request: seen on or after the request's `since_date`
 * and without any `posting_score` for the request's criteria set. A view, not a table, so
 * scoring a posting takes it out of the set with no update anywhere. A score on a different
 * set does not count, because a score only means something against the set it was made under.
 */
export const pendingRescore = pgView('pending_rescore').as((qb) =>
  qb
    .select({
      rescoreRequestId: sql<number>`${rescoreRequest.id}`.as('rescore_request_id'),
      postingId: sql<number>`${posting.id}`.as('posting_id'),
    })
    .from(rescoreRequest)
    .innerJoin(posting, gte(posting.seenAt, rescoreRequest.sinceDate))
    .where(
      sql`not exists (
        select 1 from ${postingScore}
        where ${and(
          eq(postingScore.postingId, posting.id),
          eq(postingScore.criteriaSetId, rescoreRequest.criteriaSetId),
        )}
      )`,
    ),
)
