import { z } from 'zod'

import { IdSchema } from './common.ts'

/**
 * What a caller supplies to write the summary of one position. A summary is written whole,
 * because it is regenerated from the posting each time: a field left out is cleared, not
 * kept, so a repost cannot leave last month's description beside this month's text.
 *
 * `stack` is tags as data, with no list of allowed values, and `extra` is whatever else the
 * summariser found, as JSON. `sourceHash` is how a changed posting is detected, so it must
 * name something.
 */
export const SummaryInputSchema = z.strictObject({
  positionId: IdSchema,
  stack: z.array(z.string().trim().min(1)).optional(),
  description: z.string().nullable().optional(),
  industry: z.string().nullable().optional(),
  condensed: z.string().trim().min(1),
  extra: z.record(z.string(), z.json()).optional(),
  sourceHash: z.string().trim().min(1),
})

export type SummaryInput = z.infer<typeof SummaryInputSchema>
