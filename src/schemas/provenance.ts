import { z } from 'zod'

import { bulkOf, hasNoNul, IdSchema, NO_NUL_MESSAGE } from './common.ts'

/** A calendar day as `YYYY-MM-DD`, the shape a Postgres `date` column reads and writes. */
const calendarDay = z.iso.date()

/**
 * One touch: when and through which door a lead reached the user. A machine-run query and a
 * conversation in a corridor have this same shape; only a query carries a `searchRunId`.
 * `postingId` is null until the posting exists, and `routeId` is null because the route
 * registry ships empty.
 */
export const OriginSchema = z.object({
  id: z.number().int(),
  postingId: z.number().int().nullable(),
  routeId: z.number().int().nullable(),
  // When the person was reached. User-entered and backdatable, so it can also be mistyped.
  touchedOn: calendarDay,
  // When the row was written, which is what ranks two touches on the same day.
  recordedAt: z.date(),
  // The query string, or a free line such as who said it and where.
  note: z.string().nullable(),
  searchRunId: z.number().int().nullable(),
})

/** A line of free text, trimmed and non-empty so a blank says nothing, and free of NUL, which Postgres cannot store. */
const line = z.string().trim().min(1).refine(hasNoNul, NO_NUL_MESSAGE)

/**
 * What a caller supplies to log a touch; the database assigns `id` and `recordedAt`, so neither
 * is accepted. `postingId` and `routeId` are nullable as well as optional because both are
 * absent on a real touch (a conversation before any posting, a route registry that ships empty),
 * and `touchedOn` is required and may be backdated or, by mistake, future-dated: it is stored
 * as typed and only ignored when first touch is derived.
 */
export const OriginInputSchema = z.strictObject({
  postingId: IdSchema.nullable().optional(),
  routeId: IdSchema.nullable().optional(),
  touchedOn: calendarDay,
  note: line.optional(),
  searchRunId: IdSchema.nullable().optional(),
})

export type OriginInput = z.infer<typeof OriginInputSchema>

export const OriginBulkSchema = bulkOf(OriginInputSchema)

/**
 * One machine query: what was asked and where. The database stamps when it ran. There is no
 * bulk form on purpose: recording one search run is not a collection operation.
 */
export const SearchRunInputSchema = z.strictObject({
  query: line,
  source: line,
})

export type SearchRunInput = z.infer<typeof SearchRunInputSchema>

/**
 * Tying an existing touch to a posting. Both ids are required: the touch is named, not
 * described, and only its `posting_id` changes. No date or route is accepted, because a touch
 * keeps the date and the door it was recorded with.
 */
export const OriginAttachInputSchema = z.strictObject({
  originId: IdSchema,
  postingId: IdSchema,
})

export type OriginAttachInput = z.infer<typeof OriginAttachInputSchema>
