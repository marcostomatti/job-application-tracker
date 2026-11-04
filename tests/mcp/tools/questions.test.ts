import { describe, expect, test } from 'bun:test'

import { addPostings } from '../../../src/data/repositories/postings.ts'
import { postingTools } from '../../../src/mcp/tools/postings.ts'
import { questionTools } from '../../../src/mcp/tools/questions.ts'
import { connectTools, failureText, idOf, untouchableDb, useSharedScratchDatabase } from './harness.ts'

const database = useSharedScratchDatabase()

type Question = { id: number; question: string; answer: string | null; answeredAt: string | null }

async function newPostingId(title: string): Promise<number> {
  return idOf(await addPostings(database(), [{ company: { name: `${title} Co` }, roleTitle: title }]))
}

describe('the questions group', () => {
  test('registers exactly the named tools, with no annotations', () => {
    expect(questionTools.map((tool) => tool.name).sort()).toEqual([
      'posting_question_add',
      'posting_question_add_bulk',
      'posting_question_answer',
      'posting_question_list',
    ])
    expect(questionTools.filter((tool) => tool.annotations !== undefined)).toEqual([])
  })

  test('a question is added, answered, listed and carried by posting_get', async () => {
    const client = await connectTools([...questionTools, ...postingTools], database())
    const postingId = await newPostingId('Tool asked')

    const added = (await client.call('posting_question_add', { postingId, question: 'Team size?' })).body as Question
    const answered = (await client.call('posting_question_answer', { questionId: added.id, answer: 'Six' })).body as Question
    const listed = (await client.call('posting_question_list', { postingId })).body as Question[]
    const detail = (await client.call('posting_get', { postingId })).body as { questions: Question[] }

    expect(added).toMatchObject({ question: 'Team size?', answer: null, answeredAt: null })
    expect(answered.answer).toBe('Six')
    expect(answered.answeredAt).not.toBeNull()
    expect(listed).toEqual([answered])
    expect(detail.questions).toEqual([answered])
  })

  test('a bulk import run twice leaves the questions and their answers as the user left them', async () => {
    const client = await connectTools(questionTools, database())
    const postingId = await newPostingId('Tool imported')
    const items = [
      { postingId, question: 'Remote?' },
      { postingId, question: 'Equity?', answer: 'imported' },
    ]
    const [remote] = (await client.call('posting_question_add_bulk', { items })).body as Question[]
    await client.call('posting_question_answer', { questionId: remote?.id, answer: 'Fully remote' })

    await client.call('posting_question_add_bulk', { items: items.map((item) => ({ ...item, answer: 'second import' })) })
    const listed = (await client.call('posting_question_list', { postingId })).body as Question[]

    expect(listed.map((row) => [row.question, row.answer])).toEqual([
      ['Remote?', 'Fully remote'],
      ['Equity?', 'imported'],
    ])
  })

  test('posting_question_answer refuses a blank answer before touching the database', async () => {
    const client = await connectTools(questionTools, untouchableDb())

    const outcome = await client.call('posting_question_answer', { questionId: 1, answer: '  ' })

    expect(outcome.failed).toBe(true)
  })

  test('posting_question_add for an unknown posting is a not-found error', async () => {
    const client = await connectTools(questionTools, database())

    const outcome = await client.call('posting_question_add', { postingId: 999_999, question: 'Anyone?' })

    expect(outcome.failed).toBe(true)
    expect(failureText(outcome)).toContain('NotFoundError')
  })
})
