import { z } from 'zod'

import { bulkOf, hasNoNul, IdSchema, jsonHasNoNul, NO_NUL_MESSAGE } from './common.ts'

/** Free text Postgres can store: NUL is refused, and the required form also refuses a blank. */
const freeText = z.string().refine(hasNoNul, NO_NUL_MESSAGE)
const requiredText = z.string().trim().min(1).refine(hasNoNul, NO_NUL_MESSAGE)

/**
 * What a caller supplies to write the summary of one posting. A summary is written whole,
 * because it is regenerated from the posting each time: a field left out is cleared, not
 * kept, so a repost cannot leave last month's description beside this month's text.
 *
 * `stack` is tags as data, with no list of allowed values, and `extra` is whatever else the
 * summariser found, as JSON. `sourceHash` is how a changed posting is detected, so it must
 * name something.
 */
export const SummaryInputSchema = z.strictObject({
  postingId: IdSchema,
  stack: z.array(requiredText).optional(),
  description: freeText.nullable().optional(),
  industry: freeText.nullable().optional(),
  condensed: requiredText,
  extra: z.record(z.string(), z.json()).refine(jsonHasNoNul, NO_NUL_MESSAGE).optional(),
  sourceHash: requiredText,
})

export type SummaryInput = z.infer<typeof SummaryInputSchema>

/** Up to `BULK_MAX` summaries to write in one call, all or none. */
export const SummaryBulkSchema = bulkOf(SummaryInputSchema)

/**
 * The question "has this posting changed since its summary was written?": the posting, and the
 * hash of the posting text as it reads now. The hash must name something, as it must when a
 * summary is written, so an empty one cannot match a stored value by accident.
 */
export const PostingChangedQuerySchema = z.strictObject({
  postingId: IdSchema,
  sourceHash: requiredText,
})

export type PostingChangedQuery = z.infer<typeof PostingChangedQuerySchema>
