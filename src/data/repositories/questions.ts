import { and, asc, eq, sql, type InferSelectModel } from 'drizzle-orm'

import { NotFoundError } from '../../errors.ts'
import type { PostingQuestionInput } from '../../schemas/questions.ts'
import { postingQuestion } from '../schema/questions.ts'
import type { Db } from './db.ts'
import { assertPostingExists } from './posting-exists.ts'

export type PostingQuestion = InferSelectModel<typeof postingQuestion>

/** The questions of one posting, in the order they were asked, with no check that it exists. */
export async function readQuestionsOf(db: Db, postingId: number): Promise<PostingQuestion[]> {
  return db.select().from(postingQuestion).where(eq(postingQuestion.postingId, postingId)).orderBy(asc(postingQuestion.id))
}

/**
 * Stores a question about one posting and returns it. An answer given with it is stored with
 * the time of the write. A question the posting already has returns the stored row unchanged,
 * answer included: the answers are the user's, so a repeated import neither duplicates a
 * question nor overwrites what came back. The insert is `ON CONFLICT DO NOTHING` then a read,
 * so two callers racing on one question both get the one row that won.
 */
export async function addQuestion(db: Db, input: PostingQuestionInput): Promise<PostingQuestion> {
  await assertPostingExists(db, input.postingId)
  const [created] = await db
    .insert(postingQuestion)
    .values({
      postingId: input.postingId,
      question: input.question,
      ...(input.answer === undefined ? {} : { answer: input.answer, answeredAt: sql`now()` }),
    })
    .onConflictDoNothing({ target: [postingQuestion.postingId, postingQuestion.question] })
    .returning()
  if (created) return created

  const [existing] = await db
    .select()
    .from(postingQuestion)
    .where(and(eq(postingQuestion.postingId, input.postingId), eq(postingQuestion.question, input.question)))
  if (!existing) throw new NotFoundError('posting question', input.question)
  return existing
}

/** Writes the answer to one question with the time of the write, replacing an earlier answer. */
export async function answerQuestion(db: Db, questionId: number, answer: string): Promise<PostingQuestion> {
  const [updated] = await db
    .update(postingQuestion)
    .set({ answer, answeredAt: sql`now()` })
    .where(eq(postingQuestion.id, questionId))
    .returning()
  if (!updated) throw new NotFoundError('posting question', questionId)
  return updated
}

/** The questions of one posting, in the order they were asked; an unknown posting is not-found. */
export async function listQuestions(db: Db, postingId: number): Promise<PostingQuestion[]> {
  await assertPostingExists(db, postingId)
  return readQuestionsOf(db, postingId)
}
