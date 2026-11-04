import { sql } from 'drizzle-orm'
import { check, integer, pgTable, text, timestamp, unique } from 'drizzle-orm/pg-core'

import { posting } from './postings.ts'

/**
 * A question the user wants answered about one role, written by hand, with the answer that came
 * back (spec section 7.4). It is not `limiter_is_unknown`, which is derived from an unrated
 * requirement. Answers are the user's: no import may overwrite one, so the repository adds a
 * question the posting already has as a no-op, and only an answer write changes `answer`.
 *
 * `answered_at` is set exactly when `answer` is, which the check holds, so a reader never meets
 * an answer with no time or a time with no answer.
 */
export const postingQuestion = pgTable(
  'posting_question',
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    postingId: integer('posting_id')
      .notNull()
      .references(() => posting.id),
    question: text().notNull(),
    answer: text(),
    answeredAt: timestamp('answered_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('posting_question_posting_question_unique').on(table.postingId, table.question),
    check('posting_question_answered_check', sql`(${table.answer} IS NULL) = (${table.answeredAt} IS NULL)`),
  ],
)
