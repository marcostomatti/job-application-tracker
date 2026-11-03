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

/**
 * Where a list starts and how much of it a caller gets. Strict, like every other input
 * schema here: a misspelled or invented page option is a mistake worth reporting, and a
 * caller who cannot see the option list is the one least able to notice a dropped field.
 */
export const PaginationSchema = z.strictObject({
  limit: numberOrNumericText.pipe(z.number().int().min(1).max(PAGE_LIMIT_MAX)).default(PAGE_LIMIT_DEFAULT),
  offset: numberOrNumericText.pipe(z.number().int().min(0)).default(0),
})

export type Pagination = z.infer<typeof PaginationSchema>

/**
 * The envelope every bulk operation takes: the single form's item schema, in a
 * bounded, non-empty array. One wrapper means the MCP tool and the HTTP route for a
 * bulk write cannot disagree about the cap or about what an empty call means.
 *
 * The envelope is as strict as the items it carries. A caller that sent `limit` beside
 * `items`, believing the envelope paginated, would otherwise lose it without a word.
 */
export function bulkOf<T extends z.ZodType>(
  item: T,
): z.ZodObject<{ items: z.ZodArray<T> }, z.core.$strict> {
  return z.strictObject({ items: z.array(item).min(1).max(BULK_MAX) })
}

/** The one character Postgres cannot store in `text` or `jsonb`. */
const NUL = '\u0000'

/**
 * A refinement for free text: refuses NUL, which the database rejects with a driver error
 * that carries the whole statement. Refused here it is a field-level validation message and
 * the failing item keeps its index; the caller fixes it by removing the character.
 */
export function hasNoNul(value: string): boolean {
  return !value.includes(NUL)
}

/** The same check for a JSON value, keys and strings at any depth. */
export function jsonHasNoNul(value: unknown): boolean {
  if (typeof value === 'string') return hasNoNul(value)
  if (Array.isArray(value)) return value.every(jsonHasNoNul)
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).every(([key, inner]) => hasNoNul(key) && jsonHasNoNul(inner))
  }
  return true
}

export const NO_NUL_MESSAGE = 'must not contain a NUL character'
