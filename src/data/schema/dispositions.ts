import { sql } from 'drizzle-orm'
import { check, index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

import { posting } from './postings.ts'
import { rejectionReason, setAsideReason, stage } from './registries.ts'

/**
 * The second axis of a posting's state, beside its stage. A lead the user passed on after a
 * second look is neither resolved nor rejected: nobody rejected the user, so it is set aside.
 * `kind` is an internal discriminator the code branches on, so a CHECK may list it.
 *
 * The two reason registries are kept apart because they do not share an author. A set-aside
 * reason is the user's own judgement about a lead, which is what refines a gate or a weight;
 * a rejection reason describes what the other side did. One shared column would mix the
 * user's criteria with the market's behaviour. Both references are nullable because the
 * registries ship empty, and the CHECK is what makes exactly the matching one required: each
 * kind carries its own reason and never the other's, so a row cannot hold both or neither.
 *
 * A posting may carry several dispositions over time, and none of them touches its stage.
 */
export const postingDisposition = pgTable(
  'posting_disposition',
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    postingId: integer('posting_id')
      .notNull()
      .references(() => posting.id, { onDelete: 'cascade' }),
    kind: text().notNull(),
    setAsideReasonId: integer('set_aside_reason_id').references(() => setAsideReason.id),
    rejectionReasonId: integer('rejection_reason_id').references(() => rejectionReason.id),
    notedAt: timestamp('noted_at', { withTimezone: true }).notNull().defaultNow(),
    note: text(),
  },
  (table) => [
    index('posting_disposition_posting_idx').on(table.postingId),
    check(
      'posting_disposition_kind_reason_check',
      sql`(${table.kind} = 'set_aside' AND ${table.setAsideReasonId} IS NOT NULL AND ${table.rejectionReasonId} IS NULL)
        OR (${table.kind} = 'rejected' AND ${table.rejectionReasonId} IS NOT NULL AND ${table.setAsideReasonId} IS NULL)`,
    ),
  ],
)

/**
 * Where a posting has been, one row per move, and only ever appended to. The current stage is
 * the latest event: order by `occurred_at`, then by `id`, because events written in one
 * transaction share a timestamp and the identity breaks the tie. There is deliberately no
 * unique key on posting and stage: a repeatable stage occurs once per round, and counting
 * those rows is how "this process had four steps" is answered. `stage_id` is nullable because
 * the stage registry ships empty.
 */
export const postingStageEvent = pgTable(
  'posting_stage_event',
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    postingId: integer('posting_id')
      .notNull()
      .references(() => posting.id, { onDelete: 'cascade' }),
    stageId: integer('stage_id').references(() => stage.id),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    note: text(),
  },
  (table) => [index('posting_stage_event_posting_time_idx').on(table.postingId, table.occurredAt, table.id)],
)
