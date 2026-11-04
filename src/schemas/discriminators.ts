/**
 * The two structural discriminators, each defined once. Every zod schema that accepts one
 * imports its constant from here, and `tests/data/discriminators.test.ts` asserts that the
 * database's CHECK constraints (`requirement_kind_check` and `position_rating_confidence_check`)
 * list exactly these members. Adding a member is therefore one edit here plus the migration
 * for the CHECK, and the test fails until both agree.
 */

/** The requirement kinds: a gate disqualifies, a soft requirement only weighs. */
export const REQUIREMENT_KINDS = ['gate', 'soft'] as const

export type RequirementKind = (typeof REQUIREMENT_KINDS)[number]

/** The confidence values a rating may carry. */
export const RATING_CONFIDENCES = ['supported', 'partial', 'unknown'] as const

export type RatingConfidence = (typeof RATING_CONFIDENCES)[number]
