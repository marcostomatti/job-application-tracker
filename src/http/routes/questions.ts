import { addQuestion, answerQuestion } from '../../data/repositories/questions.ts'
import { PostingQuestionAnswerSchema, PostingQuestionInputSchema } from '../../schemas/questions.ts'
import { route, type RouteSpec } from './spec.ts'

/**
 * The routes the operator writes questions and answers through. They are the only HTTP writers of
 * `posting_question`, and each parses with its MCP tool's own schema, so a question or an answer
 * the tool refuses (blank, too long, NUL) is refused here too.
 */
export const questionRoutes: readonly RouteSpec[] = [
  route('post', '/postings/:postingId/questions', 'posting_question_add', PostingQuestionInputSchema, async (args, db) =>
    addQuestion(db, args),
  ),
  route('put', '/questions/:questionId/answer', 'posting_question_answer', PostingQuestionAnswerSchema, async (args, db) =>
    answerQuestion(db, args.questionId, args.answer),
  ),
]
