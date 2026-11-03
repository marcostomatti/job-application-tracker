import { z } from 'zod'

/**
 * The most items one bulk call may carry. An unbounded array is a memory and
 * lock-duration risk on a single-user local database, and 500 is far above any
 * plausible paste, so the cap refuses a runaway without refusing real work.
 */
export const BULK_MAX = 500

/** How many rows a list returns when the caller asks for no particular page. */
export const PAGE_LIMIT_DEFAULT = 50

/** The largest page a caller may ask for, for the same reason `BULK_MAX` exists. */
export const PAGE_LIMIT_MAX = 200

/**
 * A whole number that may arrive as text, because an HTTP path and query string carry
 * strings while an MCP tool call carries JSON numbers. A union rather than `z.coerce`,
 * so `true` and `''` are refused instead of becoming 1 and 0.
 */
const numberOrNumericText = z.union([z.number(), z.string().regex(/^\d+$/).transform(Number)])

/** A row's primary key: a positive whole number, however the surface received it. */
export const IdSchema = numberOrNumericText.pipe(z.number().int().positive())

/** Where a list starts and how much of it a caller gets. */
export const PaginationSchema = z.object({
  limit: numberOrNumericText.pipe(z.number().int().min(1).max(PAGE_LIMIT_MAX)).default(PAGE_LIMIT_DEFAULT),
  offset: numberOrNumericText.pipe(z.number().int().min(0)).default(0),
})

export type Pagination = z.infer<typeof PaginationSchema>

/**
 * The envelope every bulk operation takes: the single form's item schema, in a
 * bounded, non-empty array. One wrapper means the MCP tool and the HTTP route for a
 * bulk write cannot disagree about the cap or about what an empty call means.
 */
export function bulkOf<T extends z.ZodType>(item: T): z.ZodObject<{ items: z.ZodArray<T> }> {
  return z.object({ items: z.array(item).min(1).max(BULK_MAX) })
}
