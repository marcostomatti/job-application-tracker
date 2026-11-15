import { sql } from 'drizzle-orm'
import { boolean, check, date, index, integer, jsonb, pgTable, pgView, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'

import { SEARCH_HIT_TRIAGE } from '../../schemas/provenance.ts'
import { posting } from './postings.ts'
import { route } from './registries.ts'

/**
 * One run of a machine query: what was asked, where, and when. It is the record that hangs
 * off an origin when the touch came from a search, and stays absent for a touch that came
 * from a person. `source` is free text because the places a search can run are not a closed
 * set.
 */
export const searchRun = pgTable('search_run', {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  query: text().notNull(),
  source: text().notNull(),
  // The search parameters as the caller sent them, any JSON, for comparing which searches find
  // the better postings. SQL NULL when none were given; a JSON null sent as params is stored
  // the same way. No screen shows it yet.
  params: jsonb(),
  ranAt: timestamp('ran_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * A dated touch through a named route: a query that surfaced a lead, a recruiter's message, a
 * conversation in a corridor. A posting reached through several doors has several rows, none
 * merged. Which one counts as first is derived (see `postingFirstTouch`), never stored on a
 * row, so a conversation remembered later and entered with an earlier `touched_on` can take
 * over.
 *
 * `posting_id` is nullable so a touch can be logged before any posting exists and attached
 * when it does. `route_id` is nullable because the route registry ships empty. A deleted
 * posting leaves its origins behind, unattached, rather than taking the provenance with it.
 * `touched_on` is user-entered, so a future date is kept as typed and is only ignored when
 * first touch is derived.
 *
 * A touch from a search run is that run's hit, so it may also say where the run listed the
 * posting (`rank`, from 1), whether the run marked it as already seen (`was_new`), and what a
 * look at the title alone decided (`title_triage`). A touch with no run carries none of the
 * three, and a run lists one posting once: the same posting from the same run again is a
 * conflict, while a touch not yet attached to a posting is not held to that.
 */
export const origin = pgTable(
  'origin',
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    postingId: integer('posting_id').references(() => posting.id, { onDelete: 'set null' }),
    routeId: integer('route_id').references(() => route.id),
    touchedOn: date('touched_on', { mode: 'string' }).notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
    note: text(),
    searchRunId: integer('search_run_id').references(() => searchRun.id),
    rank: integer(),
    wasNew: boolean('was_new'),
    titleTriage: text('title_triage', { enum: SEARCH_HIT_TRIAGE }),
  },
  (table) => [
    index('origin_posting_touch_idx').on(table.postingId, table.touchedOn, table.recordedAt, table.id),
    uniqueIndex('origin_search_run_posting_idx').on(table.searchRunId, table.postingId)
      .where(sql`${table.searchRunId} IS NOT NULL AND ${table.postingId} IS NOT NULL`),
    check('origin_rank_check', sql`${table.rank} >= 1`),
    check('origin_title_triage_check', sql`${table.titleTriage} IN ('score', 'skip_title')`),
    check(
      'origin_search_hit_needs_run_check',
      sql`${table.searchRunId} IS NOT NULL OR (${table.rank} IS NULL AND ${table.wasNew} IS NULL AND ${table.titleTriage} IS NULL)`,
    ),
  ],
)

/**
 * The origin that first reached each posting: the smallest `(touched_on, recorded_at, id)`
 * among origins not dated after today. The same rule as `firstTouch` in code, and a test
 * pins that the two agree. An origin with no posting has no row here.
 *
 * "Today" is the UTC date, `(now() AT TIME ZONE 'utc')::date`, and never `CURRENT_DATE`:
 * `CURRENT_DATE` follows the session's TimeZone setting, so a database not set to UTC would
 * answer differently from `firstTouch`, which also reads UTC. Agreement between the two beats
 * local-date precision. The only cost is a window of a few hours around midnight in which a
 * future-dated typo is filtered a little early or late, and a mistyped day corrects itself
 * the next day anyway.
 */
export const postingFirstTouch = pgView('posting_first_touch').as((qb) =>
  qb
    .selectDistinctOn([origin.postingId], {
      postingId: origin.postingId,
      originId: sql<number>`${origin.id}`.as('origin_id'),
      routeId: origin.routeId,
      touchedOn: origin.touchedOn,
    })
    .from(origin)
    .where(sql`${origin.postingId} IS NOT NULL AND ${origin.touchedOn} <= (now() AT TIME ZONE 'utc')::date`)
    .orderBy(origin.postingId, origin.touchedOn, origin.recordedAt, origin.id),
)
