import { z } from 'zod'

import { bulkOf, hasNoNul, IdSchema, NO_NUL_MESSAGE } from './common.ts'

/** Trimmed, non-empty and storable: a blank question or answer says nothing, and NUL is refused. */
const text = z.string().trim().min(1).refine(hasNoNul, NO_NUL_MESSAGE)

/**
 * The longest question stored. The unique key on `(posting_id, question)` is a btree, whose
 * entries Postgres caps at about 2.7 KB, so a longer question would fail at the index; a
 * thousand characters is room for any question asked about one role, in any script.
 */
export const QUESTION_MAX = 1000

/**
 * A question about one posting. `answer` may come with it, which is how an import carries a
 * question already answered; a question the posting already has is left exactly as stored.
 */
export const PostingQuestionInputSchema = z.strictObject({
  postingId: IdSchema,
  question: text.max(QUESTION_MAX),
  answer: text.optional(),
})

export type PostingQuestionInput = z.infer<typeof PostingQuestionInputSchema>

/** Up to `BULK_MAX` questions, all or none. */
export const PostingQuestionBulkSchema = bulkOf(PostingQuestionInputSchema)

/** The answer to one stored question. A blank answer is refused rather than read as clearing one. */
export const PostingQuestionAnswerSchema = z.strictObject({
  questionId: IdSchema,
  answer: text,
})

export type PostingQuestionAnswerInput = z.infer<typeof PostingQuestionAnswerSchema>
