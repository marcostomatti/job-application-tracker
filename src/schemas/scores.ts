import { z } from 'zod'

import { bulkOf, hasNoNul, IdSchema, NO_NUL_MESSAGE } from './common.ts'

/** Trimmed, non-empty and storable: a blank note says nothing, and NUL is refused. */
const text = z.string().trim().min(1).refine(hasNoNul, NO_NUL_MESSAGE)

/** The confidence values a rating may carry; an internal discriminator the database also lists. */
export const RATING_CONFIDENCES = ['supported', 'partial', 'unknown'] as const

const unitInterval = z.number().min(0).max(1)

/**
 * How well the position covers one detour of the rated requirement: the per-position half of a
 * detour, whose label and discount belong to the criteria set. Like a rating's, `null` is not rated.
 */
export const DetourCoverageInputSchema = z.strictObject({
  detourId: IdSchema,
  coverage: unitInterval.nullable(),
})

export type DetourCoverageInput = z.infer<typeof DetourCoverageInputSchema>

/**
 * What the scoring pass concluded about one requirement of the set. `coverage` is required but
 * nullable: `null` is "not rated", which is different from `0` ("rated, and not covered"), and
 * a caller who leaves the field out has most likely forgotten it, so it is refused rather than
 * read as either. A requirement the call does not mention at all is also not rated. `detours`
 * says how well the position covers each way round this requirement; a detour left out is not rated.
 */
export const RatingInputSchema = z.strictObject({
  requirementId: IdSchema,
  coverage: unitInterval.nullable(),
  confidence: z.enum(RATING_CONFIDENCES).default('unknown'),
  evidence: text.nullable().optional(),
  detours: z.array(DetourCoverageInputSchema).optional(),
})

export type RatingInput = z.infer<typeof RatingInputSchema>

/**
 * A signed adjustment taken off the score. `amount` is finite (`z.number()` refuses NaN and
 * both infinities) and never positive, because a penalty that raised the score would be a bonus.
 */
export const PenaltyInputSchema = z.strictObject({
  penaltyKindId: IdSchema,
  amount: z.number().max(0),
  reason: text.nullable().optional(),
})

export type PenaltyInput = z.infer<typeof PenaltyInputSchema>

const detourIdsOf = (ratings: readonly RatingInput[]): number[] =>
  ratings.flatMap((rating) => (rating.detours ?? []).map((entry) => entry.detourId))

const hasDuplicate = (values: readonly number[]): boolean => new Set(values).size !== values.length

/**
 * One scoring pass of one position against one criteria set. A requirement rated twice or a
 * detour given two coverages, or a penalty kind used twice, is refused here, where the caller can see which, because the tables
 * hold one row of each per score and would otherwise answer with a driver error.
 */
export const ScorePositionInputSchema = z
  .strictObject({
    positionId: IdSchema,
    criteriaSetId: IdSchema,
    ratings: z.array(RatingInputSchema),
    penalties: z.array(PenaltyInputSchema),
    note: text.optional(),
  })
  .superRefine((input, ctx) => {
    if (hasDuplicate(input.ratings.map((rating) => rating.requirementId))) {
      ctx.addIssue({ code: 'custom', path: ['ratings'], message: 'a requirement may be rated once per score' })
    }
    if (hasDuplicate(detourIdsOf(input.ratings))) {
      ctx.addIssue({ code: 'custom', path: ['ratings'], message: 'a detour may be given a coverage once per score' })
    }
    if (hasDuplicate(input.penalties.map((penalty) => penalty.penaltyKindId))) {
      ctx.addIssue({ code: 'custom', path: ['penalties'], message: 'a penalty kind may be used once per score' })
    }
  })

export type ScorePositionInput = z.infer<typeof ScorePositionInputSchema>

export const ScorePositionBulkSchema = bulkOf(ScorePositionInputSchema)

/** The position whose scores a read returns. */
export const PositionScoresQuerySchema = z.strictObject({ positionId: IdSchema })

export type PositionScoresQuery = z.infer<typeof PositionScoresQuerySchema>

/** A request that every position seen on or after `sinceDate` be scored against the set. */
export const RescoreRequestInputSchema = z.strictObject({
  criteriaSetId: IdSchema,
  sinceDate: z.iso.date(),
})

export type RescoreRequestInput = z.infer<typeof RescoreRequestInputSchema>

/** Which pending positions a read returns: those of one request, or of every request. */
export const PendingRescoreQuerySchema = z.strictObject({
  rescoreRequestId: IdSchema.optional(),
})

export type PendingRescoreQuery = z.infer<typeof PendingRescoreQuerySchema>
