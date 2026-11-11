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

/** The longest `params` a search run keeps, as JSON text: a set of search filters, not a document. */
export const SEARCH_PARAMS_MAX_CHARS = 65_536

/** How deep `params` may nest. Search filters are shallow, and a cap keeps the checks off the stack limit. */
export const SEARCH_PARAMS_MAX_DEPTH = 32

/**
 * Why a JSON value cannot be kept, or `undefined` when it can: deeper than `maxDepth`, or a key
 * or string holding NUL. It walks with its own stack rather than recursing, so a value nested
 * thousands of levels deep is refused instead of overflowing the call stack.
 */
function jsonProblem(value: unknown, maxDepth: number): string | undefined {
  const pending: Array<{ readonly value: unknown; readonly depth: number }> = [{ value, depth: 0 }]
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (next.depth > maxDepth) return `must nest at most ${maxDepth} levels deep`
    if (typeof next.value === 'string') {
      if (!hasNoNul(next.value)) return NO_NUL_MESSAGE
    } else if (Array.isArray(next.value)) {
      for (const item of next.value) pending.push({ value: item, depth: next.depth + 1 })
    } else if (typeof next.value === 'object' && next.value !== null) {
      for (const [key, item] of Object.entries(next.value)) {
        if (!hasNoNul(key)) return NO_NUL_MESSAGE
        pending.push({ value: item, depth: next.depth + 1 })
      }
    }
  }
  return undefined
}

/**
 * The parameters of a search, any JSON value, kept as given so searches can be compared by
 * what they asked for. It is listed as "any value" with a description, because the recursive
 * JSON type publishes as a `$ref` some clients cannot read. The value arrived as JSON, so it is
 * JSON; what is checked is its depth, NUL in a key or string, and then its length as JSON text,
 * measured only once the depth is known to be small.
 */
const searchParams = z
  .unknown()
  .superRefine((value, ctx) => {
    const problem = jsonProblem(value, SEARCH_PARAMS_MAX_DEPTH)
    if (problem !== undefined) {
      ctx.addIssue({ code: 'custom', message: problem })
      return
    }
    if (JSON.stringify(value).length > SEARCH_PARAMS_MAX_CHARS) {
      ctx.addIssue({ code: 'custom', message: `must be at most ${SEARCH_PARAMS_MAX_CHARS} characters as JSON` })
    }
  })
  .describe(
    `The search parameters, any JSON value (an object, an array, a string, a number or a boolean), kept as given. ` +
      `Null or left out means none. At most ${SEARCH_PARAMS_MAX_CHARS} characters as JSON and ${SEARCH_PARAMS_MAX_DEPTH} levels deep.`,
  )

/**
 * One machine query: what was asked, where, and optionally its parameters as JSON. The
 * database stamps when it ran. There is no bulk form on purpose: recording one search run is
 * not a collection operation.
 */
export const SearchRunInputSchema = z.strictObject({
  query: line,
  source: line,
  params: searchParams.nullable().optional(),
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
