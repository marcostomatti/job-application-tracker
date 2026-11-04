import { z } from 'zod'

import { bulkOf, hasNoNul, IdSchema, NO_NUL_MESSAGE } from './common.ts'
import { RATING_CONFIDENCES } from './discriminators.ts'

/** Trimmed, non-empty and storable: a blank note says nothing, and NUL is refused. */
const text = z.string().trim().min(1).refine(hasNoNul, NO_NUL_MESSAGE)

const unitInterval = z.number().min(0).max(1)

/**
 * How well the posting covers one detour of the rated requirement: the per-posting half of a
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
 * read as either. A requirement the call does not mention at all is also not rated.
 *
 * `detours` says how well the posting covers each way round this requirement; a detour left
 * out is not rated. A detour coverage qualifies a rating of the same requirement, so it needs
 * that rating to exist: a caller with no direct assessment of the requirement but a detour to
 * report sends the rating with `coverage: null` and the detour beside it. The requirement then
 * counts as rated by the detour, at its coverage times what the detour keeps. Without the rating
 * the database refuses the coverage.
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

/** Every detour id a call gives a coverage, across all its ratings. */
export const detourIdsOf = (ratings: readonly RatingInput[]): number[] =>
  ratings.flatMap((rating) => (rating.detours ?? []).map((entry) => entry.detourId))

const hasDuplicate = (values: readonly number[]): boolean => new Set(values).size !== values.length

/**
 * One scoring pass of one posting against one criteria set. A requirement rated twice or a
 * detour given two coverages, or a penalty kind used twice, is refused here, where the caller can see which, because the tables
 * hold one row of each per score and would otherwise answer with a driver error.
 */
export const ScorePostingInputSchema = z
  .strictObject({
    postingId: IdSchema,
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

export type ScorePostingInput = z.infer<typeof ScorePostingInputSchema>

export const ScorePostingBulkSchema = bulkOf(ScorePostingInputSchema)

/** The posting whose scores a read returns. */
export const PostingScoresQuerySchema = z.strictObject({ postingId: IdSchema })

export type PostingScoresQuery = z.infer<typeof PostingScoresQuerySchema>

/** A request that every posting seen on or after `sinceDate` be scored against the set. */
export const RescoreRequestInputSchema = z.strictObject({
  criteriaSetId: IdSchema,
  sinceDate: z.iso.date(),
})

export type RescoreRequestInput = z.infer<typeof RescoreRequestInputSchema>

/** Which pending postings a read returns: those of one request, or of every request. */
export const PendingRescoreQuerySchema = z.strictObject({
  rescoreRequestId: IdSchema.optional(),
})

export type PendingRescoreQuery = z.infer<typeof PendingRescoreQuerySchema>
