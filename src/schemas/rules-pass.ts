import { z } from 'zod'

import { BULK_MAX, IdSchema } from './common.ts'

/** How many postings one rules pass looks at when the call names no limit. */
export const RULES_PASS_DEFAULT_LIMIT = 20

/**
 * One run of the rules pass over postings with no score under a set. `write` is required, so a
 * caller says on every call whether scores are stored or only reported. `afterPostingId` is the
 * cursor a previous run returned, because a posting the rules leave unrated stays unscored and
 * would otherwise come first again.
 */
export const RulesPassInputSchema = z.strictObject({
  criteriaSetId: IdSchema.optional().describe('The criteria set whose rules to apply; left out, the default set.'),
  limit: z.number().int().min(1).max(BULK_MAX).default(RULES_PASS_DEFAULT_LIMIT)
    .describe(`How many unscored postings to look at, from 1 to ${BULK_MAX}.`),
  afterPostingId: IdSchema.optional().describe('Look only at postings with a higher id: the nextAfterPostingId of the previous run.'),
  write: z.boolean().describe('True stores a score for every posting a rule rates 0; false only reports what it would store.'),
})

export type RulesPassInput = z.infer<typeof RulesPassInputSchema>
