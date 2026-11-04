import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { lintMigrations } from '../../drizzle/lint/migration-lint'
import { addPostings, getPosting } from '../../src/data/repositories/postings.ts'
import { addQuestion, answerQuestion, listQuestions } from '../../src/data/repositories/questions.ts'
import { postingQuestion } from '../../src/data/schema/questions.ts'
import { NotFoundError } from '../../src/errors.ts'
import { PostingQuestionAnswerSchema, PostingQuestionInputSchema, QUESTION_MAX } from '../../src/schemas/questions.ts'
import { inOneTransaction } from '../../src/mcp/bulk.ts'
import { thrownBy, violationText } from '../data/rolled-back.ts'
import { useSharedScratchDatabase } from '../mcp/tools/harness.ts'

const MIGRATIONS_DIR = join(import.meta.dir, '..', '..', 'drizzle')

const database = useSharedScratchDatabase()

async function newPostingId(title: string): Promise<number> {
  const [created] = await addPostings(database(), [{ company: { name: `${title} Co` }, roleTitle: title }])
  if (!created) throw new Error('the arrangement stored no posting')
  return created.id
}

describe('the posting_question and text_asset_posting tables', () => {
  test('are added by one migration that passes the lint', () => {
    // Arrange
    const names = readdirSync(MIGRATIONS_DIR).filter((name) => /^0013_.*\.sql$/.test(name))
    expect(names).toHaveLength(1)
    const migration = join(MIGRATIONS_DIR, names[0] as string)

    // Act
    const sqlText = readFileSync(migration, 'utf8')
    const findings = lintMigrations(MIGRATIONS_DIR).filter((finding) => finding.file === migration)

    // Assert
    expect(sqlText).toContain('CREATE TABLE "posting_question"')
    expect(sqlText).toContain('CREATE TABLE "text_asset_posting"')
    expect(findings).toEqual([])
  })

  test('refuse an answer stored without its time, so the two are set together', async () => {
    // Arrange
    const postingId = await newPostingId('Checked question')

    // Act
    const error = await thrownBy(() =>
      database().insert(postingQuestion).values({ postingId, question: 'Unchecked?', answer: 'yes' }),
    )

    // Assert
    expect(violationText(error)).toContain('posting_question_answered_check')
  })
})

describe('addQuestion', () => {
  test('stores a question with no answer', async () => {
    // Arrange
    const postingId = await newPostingId('Asked')

    // Act
    const stored = await addQuestion(database(), { postingId, question: 'Is the team remote?' })

    // Assert
    expect(stored).toMatchObject({ postingId, question: 'Is the team remote?', answer: null, answeredAt: null })
  })

  test('stores an answer that arrives with the question, with the time it was written', async () => {
    // Arrange
    const postingId = await newPostingId('Answered on arrival')

    // Act
    const stored = await addQuestion(database(), { postingId, question: 'Salary band?', answer: 'Not shared yet' })

    // Assert
    expect(stored.answer).toBe('Not shared yet')
    expect(stored.answeredAt).toBeInstanceOf(Date)
  })

  test('returns the stored row unchanged for a question the posting already has, so an import never overwrites an answer', async () => {
    // Arrange
    const postingId = await newPostingId('Asked twice')
    const first = await addQuestion(database(), { postingId, question: 'Visa sponsorship?' })
    const answered = await answerQuestion(database(), first.id, 'Yes, for this role')

    // Act
    const again = await addQuestion(database(), { postingId, question: 'Visa sponsorship?', answer: 'imported guess' })

    // Assert
    expect(again).toEqual(answered)
    expect(await listQuestions(database(), postingId)).toHaveLength(1)
  })

  test('one question twice in one transaction is stored once, as a bulk call carrying it twice would', async () => {
    // Arrange
    const postingId = await newPostingId('Asked twice in one call')
    const item = { postingId, question: 'Relocation?' }

    // Act
    const [first, second] = await inOneTransaction(database(), [item, { ...item, answer: 'later' }], (tx, entry) =>
      addQuestion(tx, entry),
    )

    // Assert
    expect(second).toEqual(first)
    expect(await listQuestions(database(), postingId)).toHaveLength(1)
  })

  test('an unknown posting is a not-found error', async () => {
    // Act
    const error = await thrownBy(() => addQuestion(database(), { postingId: 999_999, question: 'Anyone there?' }))

    // Assert
    expect(error).toBeInstanceOf(NotFoundError)
  })
})

describe('answerQuestion', () => {
  test('writes the answer and the time, and a second answer replaces the first', async () => {
    // Arrange
    const postingId = await newPostingId('Answered later')
    const asked = await addQuestion(database(), { postingId, question: 'Start date?' })

    // Act
    const first = await answerQuestion(database(), asked.id, 'March')
    const second = await answerQuestion(database(), asked.id, 'April, after the reorg')

    // Assert
    expect(first.answer).toBe('March')
    expect(second).toMatchObject({ id: asked.id, answer: 'April, after the reorg' })
    expect(second.answeredAt).toBeInstanceOf(Date)
  })

  test('an unknown question is a not-found error', async () => {
    // Act
    const error = await thrownBy(() => answerQuestion(database(), 999_999, 'nobody asked'))

    // Assert
    expect(error).toBeInstanceOf(NotFoundError)
  })
})

describe('listQuestions', () => {
  test('lists the questions of one posting in the order they were asked', async () => {
    // Arrange
    const postingId = await newPostingId('Listed questions')
    const otherId = await newPostingId('Other questions')
    await addQuestion(database(), { postingId, question: 'First?' })
    await addQuestion(database(), { postingId: otherId, question: 'Elsewhere?' })
    await addQuestion(database(), { postingId, question: 'Second?' })

    // Act
    const listed = await listQuestions(database(), postingId)

    // Assert
    expect(listed.map((row) => row.question)).toEqual(['First?', 'Second?'])
  })

  test('an unknown posting is a not-found error, and a posting with none is an empty list', async () => {
    // Arrange
    const postingId = await newPostingId('No questions')

    // Act
    const error = await thrownBy(() => listQuestions(database(), 999_999))

    // Assert
    expect(error).toBeInstanceOf(NotFoundError)
    expect(await listQuestions(database(), postingId)).toEqual([])
  })

  test('getPosting carries the questions of the posting', async () => {
    // Arrange
    const postingId = await newPostingId('Detail questions')
    await addQuestion(database(), { postingId, question: 'On call?' })

    // Act
    const detail = await getPosting(database(), postingId)

    // Assert
    expect(detail.questions.map((row) => row.question)).toEqual(['On call?'])
  })
})

describe('the question schemas', () => {
  test('refuse a blank question and a blank answer', () => {
    // Assert
    expect(PostingQuestionInputSchema.safeParse({ postingId: 1, question: '   ' }).success).toBe(false)
    expect(PostingQuestionInputSchema.safeParse({ postingId: 1, question: 'q'.repeat(QUESTION_MAX) }).success).toBe(true)
    expect(PostingQuestionInputSchema.safeParse({ postingId: 1, question: 'q'.repeat(QUESTION_MAX + 1) }).success).toBe(false)
    expect(PostingQuestionAnswerSchema.safeParse({ questionId: 1, answer: '' }).success).toBe(false)
    expect(PostingQuestionAnswerSchema.safeParse({ questionId: 1, answer: 'x', answeredAt: 'now' }).success).toBe(false)
  })
})
