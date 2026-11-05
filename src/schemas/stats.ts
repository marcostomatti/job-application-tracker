import { z } from 'zod'

import { ScaleSchema } from '../scoring/scale.ts'
import { IdSchema } from './common.ts'

const ratio = z.number().min(0).max(1)

/** A read of the market stats: which criteria set, which scale, and an ask floor to try without storing it. */
export const MarketStatsQuerySchema = z.strictObject({
  criteriaSetId: IdSchema.optional().describe('The criteria set to read scores against. Unset: the default set, else the newest active one.'),
  scale: ScaleSchema,
  askFloor: z.coerce
    .number()
    .pipe(ratio)
    .optional()
    .describe('A ratio (0..1) to start the ask band at for this read only. Unset: the stored stats_ask_floor, else 0.50.'),
})

export type MarketStatsQuery = z.infer<typeof MarketStatsQuerySchema>

/** Stores the ratio the `ask` lead band starts at. */
export const AskFloorInputSchema = z.strictObject({
  askFloor: ratio.describe('A ratio from 0 to 1. 0.50 is 2.5 stars; the apply band starts at the set\'s apply threshold.'),
})
