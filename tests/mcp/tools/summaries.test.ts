import { describe, expect, test } from 'bun:test'

import { addPositions } from '../../../src/data/repositories/positions.ts'
import { summaryTools } from '../../../src/mcp/tools/summaries.ts'
import { connectTools, failureText, idOf, untouchableDb, useSharedScratchDatabase } from './harness.ts'

const database = useSharedScratchDatabase()

async function newPositionId(title: string): Promise<number> {
  return idOf(await addPositions(database(), [{ company: { name: `${title} Co` }, roleTitle: title }]))
}

describe('the summaries group', () => {
  test('the summaries group registers exactly the named tools', () => {
    expect(summaryTools.map((tool) => tool.name).sort()).toEqual(['summary_get', 'summary_write'])
  })

  test('no tool sets annotations, which are left for the author to decide', () => {
    expect(summaryTools.filter((tool) => tool.annotations !== undefined)).toEqual([])
  })

  test('summary_write stores a summary and summary_get reads it back', async () => {
    const client = await connectTools(summaryTools, database())
    const positionId = await newPositionId('Written')

    const written = await client.call('summary_write', {
      positionId,
      stack: ['typescript', 'postgres'],
      condensed: 'Builds a tracker.',
      sourceHash: 'hash-1',
    })
    const read = await client.call('summary_get', { positionId })

    expect(written.failed).toBe(false)
    expect(written.body).toMatchObject({ positionId, stack: ['typescript', 'postgres'], sourceHash: 'hash-1' })
    expect(read.body).toEqual(written.body)
  })

  test('summary_write replaces the earlier summary in full, so a field left out is cleared', async () => {
    const client = await connectTools(summaryTools, database())
    const positionId = await newPositionId('Replaced')
    await client.call('summary_write', { positionId, stack: ['go'], industry: 'finance', condensed: 'Old.', sourceHash: 'a' })

    const second = await client.call('summary_write', { positionId, condensed: 'New.', sourceHash: 'b' })

    expect(second.body).toMatchObject({ stack: [], industry: null, condensed: 'New.', sourceHash: 'b' })
  })

  test('summary_get returns null for a position with no summary, and not-found for no position', async () => {
    const client = await connectTools(summaryTools, database())
    const positionId = await newPositionId('Unsummarised')

    const none = await client.call('summary_get', { positionId })
    const missing = await client.call('summary_get', { positionId: 999_999 })

    expect(none).toEqual({ failed: false, body: null })
    expect(missing.failed).toBe(true)
    expect(failureText(missing)).toContain('position 999999 does not exist')
  })

  test('summary_write for an unknown position is a not-found error and writes nothing', async () => {
    const client = await connectTools(summaryTools, database())

    const outcome = await client.call('summary_write', { positionId: 999_999, condensed: 'x', sourceHash: 'h' })

    expect(outcome.failed).toBe(true)
    expect(failureText(outcome)).toContain('position 999999 does not exist')
  })

  test('summary_write rejects an input missing sourceHash, and an array, before touching the database', async () => {
    const client = await connectTools(summaryTools, untouchableDb())

    const noHash = await client.call('summary_write', { positionId: 1, condensed: 'x' })
    const array = await client.call('summary_write', { items: [{ positionId: 1, condensed: 'x', sourceHash: 'h' }] })

    expect(noHash.failed).toBe(true)
    expect(failureText(noHash)).toContain('sourceHash')
    expect(array.failed).toBe(true)
  })
})
