import { addQuestion, answerQuestion, listQuestions } from '../../data/repositories/questions.ts'
import { PostingRefSchema } from '../../schemas/postings.ts'
import { PostingQuestionAnswerSchema, PostingQuestionBulkSchema, PostingQuestionInputSchema } from '../../schemas/questions.ts'
import { inOneTransaction } from '../bulk.ts'
import { defineTool, type ToolDefinition } from '../register.ts'

/** §11.1 group 1, added 2026-11-04: the questions the user wants answered about one posting. */
export const questionTools: ToolDefinition[] = [
  defineTool({
    name: 'posting_question_add',
    title: 'Add a question about a posting',
    description:
      'Stores ONE question about ONE posting, written by hand, and returns it as stored, with its id. An answer may come with it, for a question already answered. ' +
      'A question the posting already has (the same wording) returns the stored row unchanged, answer included: answers are the user\'s, so an import run twice never duplicates a question or overwrites an answer. ' +
      'To change an answer use posting_question_answer. An unknown posting is a not-found error.',
    input: PostingQuestionInputSchema,
    run: async (args, db) => addQuestion(db, args),
  }),
  defineTool({
    name: 'posting_question_add_bulk',
    title: 'Add several questions',
    description:
      'Stores up to 500 questions in one call, each exactly as posting_question_add takes it, and returns them in the order given; a question a posting already has comes back as stored, unchanged. ' +
      'All or none: if any item fails, nothing is stored and the error names the failing item by its index. ' +
      'Prefer this to repeated posting_question_add calls when importing questions.',
    input: PostingQuestionBulkSchema,
    run: async (args, db) => inOneTransaction(db, args.items, (tx, item) => addQuestion(tx, item)),
  }),
  defineTool({
    name: 'posting_question_answer',
    title: 'Answer a question about a posting',
    description:
      'Writes the answer to ONE stored question, by its id, with the time of the write as answeredAt, and returns the question. ' +
      'This is the only tool that changes an answer, and a new answer replaces the earlier one. A blank answer is refused. ' +
      'An unknown question id is a not-found error; get ids from posting_question_list or posting_get.',
    input: PostingQuestionAnswerSchema,
    run: async (args, db) => answerQuestion(db, args.questionId, args.answer),
  }),
  defineTool({
    name: 'posting_question_list',
    title: 'List the questions about a posting',
    description:
      'Lists the questions of ONE posting in the order they were asked, each with its answer and answeredAt, or null for both while unanswered. ' +
      'posting_get carries the same list beside the rest of the posting. A posting with no questions returns an empty list; an unknown posting is a not-found error.',
    input: PostingRefSchema,
    run: async (args, db) => listQuestions(db, args.postingId),
  }),
]
