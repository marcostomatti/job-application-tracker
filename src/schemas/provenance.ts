import { z } from 'zod'

/** A calendar day as `YYYY-MM-DD`, the shape a Postgres `date` column reads and writes. */
const calendarDay = z.iso.date()

/**
 * One touch: when and through which door a lead reached the user. A machine-run query and a
 * conversation in a corridor have this same shape; only a query carries a `searchRunId`.
 * `positionId` is null until the position exists, and `routeId` is null because the route
 * registry ships empty.
 */
export const OriginSchema = z.object({
  id: z.number().int(),
  positionId: z.number().int().nullable(),
  routeId: z.number().int().nullable(),
  // When the person was reached. User-entered and backdatable, so it can also be mistyped.
  touchedOn: calendarDay,
  // When the row was written, which is what ranks two touches on the same day.
  recordedAt: z.date(),
  // The query string, or a free line such as who said it and where.
  note: z.string().nullable(),
  searchRunId: z.number().int().nullable(),
})

/** What a caller supplies to log a touch; the database assigns `id` and `recordedAt`. */
export const NewOriginSchema = z.object({
  positionId: z.number().int().nullable().default(null),
  routeId: z.number().int().nullable().default(null),
  touchedOn: calendarDay,
  note: z.string().nullable().default(null),
  searchRunId: z.number().int().nullable().default(null),
})

export const NewSearchRunSchema = z.object({
  query: z.string().min(1),
  source: z.string().min(1),
})
