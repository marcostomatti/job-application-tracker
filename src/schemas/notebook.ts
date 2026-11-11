import { z } from 'zod'

import { booleanOrText, IdSchema } from './common.ts'

/**
 * Inputs of the Open Notebook tools. These values go to another service, not to Postgres, so
 * the NUL rule of the tracker's own schemas does not apply; the bounds here keep a call to a
 * size the notebook and a tool result can carry.
 */

/** Open Notebook's own page cap on `GET /api/sources`. */
export const SOURCE_PAGE_MAX = 100

/** The most text one source may carry through these tools: far above a posting or a CV. */
export const SOURCE_TEXT_MAX = 2_000_000

/** How much of a source's text one read returns unless the caller asks for less or more. */
export const SOURCE_WINDOW_DEFAULT = 20_000

/** The largest window one read may ask for, so a result stays a size a client can hold. */
export const SOURCE_WINDOW_MAX = 200_000

const TITLE_MAX = 500
const NOTE_MAX = 200_000
const QUERY_MAX = 2_000
const SEARCH_LIMIT_MAX = 100
const NOTEBOOKS_PER_SOURCE_MAX = 50

/**
 * A SurrealDB record id of one table, as Open Notebook returns it: `notebook:…`, `source:…`.
 * The part after the colon is limited to letters, digits, `_` and `-`, so an id can never be
 * a path segment such as `..` once it is put in a URL.
 */
function recordId(table: string): z.ZodString {
  return z
    .string()
    .regex(new RegExp(`^${table}:[A-Za-z0-9_-]{1,100}$`), `must be an Open Notebook ${table} id, such as ${table}:abc123`)
}

export const NotebookIdSchema = recordId('notebook')
export const SourceIdSchema = recordId('source')

const title = z.string().trim().min(1).max(TITLE_MAX)
const whole = (min: number, max: number): z.ZodType<number> => z.number().int().min(min).max(max)

export const NotebookListSchema = z.strictObject({ includeArchived: booleanOrText.optional() })

export const NotebookCreateSchema = z.strictObject({
  name: title,
  description: z.string().max(TITLE_MAX * 4).default(''),
})

export const SourceListSchema = z.strictObject({
  notebookId: NotebookIdSchema.optional(),
  limit: whole(1, SOURCE_PAGE_MAX).default(50),
  offset: whole(0, Number.MAX_SAFE_INTEGER).default(0),
})

export const SourceGetSchema = z.strictObject({
  sourceId: SourceIdSchema,
  offset: whole(0, SOURCE_TEXT_MAX).default(0),
  maxChars: whole(1, SOURCE_WINDOW_MAX).default(SOURCE_WINDOW_DEFAULT),
})

export const SourceRefSchema = z.strictObject({ sourceId: SourceIdSchema })

export const SourceAddTextSchema = z.strictObject({
  title,
  content: z.string().min(1).max(SOURCE_TEXT_MAX),
  notebookIds: z.array(NotebookIdSchema).min(1).max(NOTEBOOKS_PER_SOURCE_MAX),
  embed: z.boolean().default(true),
})

export const PostingStoreSchema = z.strictObject({
  postingId: IdSchema,
  notebookId: NotebookIdSchema,
  content: z.string().min(1).max(SOURCE_TEXT_MAX),
  embed: z.boolean().default(true),
})

/** The most items one bulk store sends: each is one request to the notebook, made one after another. */
export const BULK_STORE_MAX = 50

/**
 * The most text one bulk store carries, all items together. A single source may be larger
 * (`SOURCE_TEXT_MAX`); a call this size stays a few megabytes on the wire and a short wait.
 */
export const BULK_STORE_TEXT_MAX = 1_000_000

const bulkText = z.string().min(1).max(BULK_STORE_TEXT_MAX)

/** Refuses a bulk call whose items' texts add up to more than `BULK_STORE_TEXT_MAX`. */
function withinBulkText<T extends { readonly content: string }>(items: readonly T[], ctx: z.RefinementCtx): void {
  const total = items.reduce((sum, item) => sum + item.content.length, 0)
  if (total > BULK_STORE_TEXT_MAX) {
    ctx.addIssue({ code: 'custom', path: ['items'], message: `the items' texts add up to ${total} characters; at most ${BULK_STORE_TEXT_MAX} per call` })
  }
}

/**
 * Several postings stored into one notebook in one call. A posting named twice is refused,
 * because both copies would carry the same title and the later would hide the earlier.
 */
export const PostingStoreBulkSchema = z
  .strictObject({
    notebookId: NotebookIdSchema,
    embed: z.boolean().default(true),
    items: z.array(z.strictObject({ postingId: IdSchema, content: bulkText })).min(1).max(BULK_STORE_MAX),
  })
  .superRefine((input, ctx) => {
    withinBulkText(input.items, ctx)
    const seen = new Set<number>()
    input.items.forEach((item, index) => {
      if (seen.has(item.postingId)) ctx.addIssue({ code: 'custom', path: ['items', index, 'postingId'], message: `posting ${item.postingId} is named twice` })
      seen.add(item.postingId)
    })
  })

/** Several texts stored as sources in the same notebooks in one call, each with its own title. */
export const SourceAddTextBulkSchema = z
  .strictObject({
    notebookIds: z.array(NotebookIdSchema).min(1).max(NOTEBOOKS_PER_SOURCE_MAX),
    embed: z.boolean().default(true),
    items: z.array(z.strictObject({ title, content: bulkText })).min(1).max(BULK_STORE_MAX),
  })
  .superRefine((input, ctx) => withinBulkText(input.items, ctx))

export const PostingSourcesSchema = z.strictObject({
  postingId: IdSchema,
  notebookId: NotebookIdSchema.optional(),
})

export const SearchSchema = z.strictObject({
  query: z.string().trim().min(1).max(QUERY_MAX),
  type: z.enum(['text', 'vector']).default('text'),
  notebookId: NotebookIdSchema.optional(),
  limit: whole(1, SEARCH_LIMIT_MAX).default(20),
  searchSources: z.boolean().default(true),
  searchNotes: z.boolean().default(true),
})

export const NoteAddSchema = z.strictObject({
  notebookId: NotebookIdSchema,
  title: title.optional(),
  content: z.string().min(1).max(NOTE_MAX),
})
