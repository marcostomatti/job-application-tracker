import { describe, expect, test } from 'bun:test'

import type { DrizzleClient } from '../../../src/data/client.ts'
import { addPostings } from '../../../src/data/repositories/postings.ts'
import { criteriaTools } from '../../../src/mcp/tools/criteria.ts'
import { postingTools } from '../../../src/mcp/tools/postings.ts'
import { scoreTools } from '../../../src/mcp/tools/scores.ts'
import { SCALE_NAMES, toScale, type Scale } from '../../../src/scoring/scale.ts'
import { arrangeSet } from './criteria-arrangement.ts'
import { connectTools, failureText, type ToolClient, useSharedScratchDatabase } from './harness.ts'

const database = useSharedScratchDatabase()

type Shown = {
  overall: number | null
  floor: number | null
  ceiling: number | null
  recommendApply: boolean
  limiterCoverage: number | null
}

type Arranged = { postingId: number; companyId: number; setId: number; requirementId: number }

async function arrange(db: DrizzleClient, name: string): Promise<Arranged> {
  const [created] = await addPostings(db, [{ company: { name: `${name} Co` }, roleTitle: name, seenAt: '2026-06-01' }])
  if (!created) throw new Error('the arranged posting was not stored')
  return { postingId: created.id, companyId: created.companyId, ...(await arrangeSet(db, name)) }
}

/** A pass whose one requirement is 0.7234 covered, so every scale has digits to round. */
const partly = (arranged: Arranged, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  postingId: arranged.postingId,
  criteriaSetId: arranged.setId,
  ratings: [{ requirementId: arranged.requirementId, coverage: 0.7234, confidence: 'supported' }],
  penalties: [],
  ...extra,
})

async function client(): Promise<ToolClient> {
  return connectTools([...scoreTools, ...postingTools, ...criteriaTools], database())
}

/** The stored ratio score of a scored posting, read back with no scale. */
async function storedScore(tools: ToolClient, postingId: number): Promise<Shown> {
  const [row] = (await tools.call('score_history', { postingId })).body as Shown[]
  if (!row) throw new Error('the posting has no stored score')
  return row
}

/** What a score shows on `scale`, from the stored ratio, by the module's own mapping. */
const expectedOn = (stored: Shown, scale: Scale): Shown => ({
  ...stored,
  overall: toScale(stored.overall, scale),
  floor: toScale(stored.floor, scale),
  ceiling: toScale(stored.ceiling, scale),
})

/** The fields a scale touches, and the verdict it must not: what every score shape shares. */
const valuesOf = ({ overall, floor, ceiling, recommendApply }: Shown): Partial<Shown> => ({
  overall,
  floor,
  ceiling,
  recommendApply,
})

describe('the scale parameter', () => {
  test('score_posting answers on the scale asked for and stores the ratio', async () => {
    const tools = await client()
    const arranged = await arrange(database(), 'Scaled single')

    const outcome = await tools.call('score_posting', partly(arranged, { scale: 'percent' }))
    const stored = await storedScore(tools, arranged.postingId)

    expect(stored.overall).toBeGreaterThan(0)
    expect(stored.overall).toBeLessThan(1)
    expect((outcome.body as { score: Shown }).score).toMatchObject(expectedOn(stored, 'percent'))
  })

  test('score_posting_bulk applies one scale, given outside items, to every answer', async () => {
    const tools = await client()
    const first = await arrange(database(), 'Scaled bulk one')
    const second = await arrange(database(), 'Scaled bulk two')

    const outcome = await tools.call('score_posting_bulk', { items: [partly(first), partly(second)], scale: 'stars' })
    const answers = (outcome.body as Array<{ score: Shown }>).map((answer) => answer.score)

    expect(answers[0]).toMatchObject(expectedOn(await storedScore(tools, first.postingId), 'stars'))
    expect(answers[1]).toMatchObject(expectedOn(await storedScore(tools, second.postingId), 'stars'))
  })

  test('score_posting_bulk refuses a scale inside an item, where it would read as per-item', async () => {
    const tools = await client()
    const arranged = await arrange(database(), 'Scaled bulk item')

    const outcome = await tools.call('score_posting_bulk', { items: [partly(arranged, { scale: 'stars' })] })

    expect(outcome.failed).toBe(true)
  })

  test('score_history and score_best scale the overall and bounds and leave the limiter coverage as stored', async () => {
    const tools = await client()
    const arranged = await arrange(database(), 'Scaled reads')
    await tools.call('score_posting', partly(arranged))
    const stored = await storedScore(tools, arranged.postingId)

    const history = (await tools.call('score_history', { postingId: arranged.postingId, scale: 'basic' })).body as Shown[]
    const best = (await tools.call('score_best', { postingId: arranged.postingId, scale: 'basic' })).body as Shown[]

    expect(history[0]).toMatchObject(expectedOn(stored, 'basic'))
    expect(best[0]).toMatchObject(expectedOn(stored, 'basic'))
    expect(history[0]?.limiterCoverage).toBe(stored.limiterCoverage)
  })

  test('every scale keeps recommendApply as stored, so a round trip never changes a recommendation', async () => {
    const tools = await client()
    const arranged = await arrange(database(), 'Scaled verdict')
    await tools.call('score_posting', partly(arranged))
    const stored = await storedScore(tools, arranged.postingId)

    for (const scale of SCALE_NAMES) {
      const [shown] = (await tools.call('score_best', { postingId: arranged.postingId, scale })).body as Shown[]
      expect({ scale, verdict: shown?.recommendApply }).toEqual({ scale, verdict: stored.recommendApply })
    }
  })

  test('no scale and scale ratio give the same answer as stored', async () => {
    const tools = await client()
    const arranged = await arrange(database(), 'Scaled default')
    await tools.call('score_posting', partly(arranged))

    const bare = await tools.call('posting_get', { postingId: arranged.postingId })
    const ratio = await tools.call('posting_get', { postingId: arranged.postingId, scale: 'ratio' })

    expect(ratio.body).toEqual(bare.body)
    expect((bare.body as { scores: Array<{ score: Shown }> }).scores[0]?.score.overall).toBe(
      (await storedScore(tools, arranged.postingId)).overall,
    )
  })

  test('posting_get scales each score and leaves its ratings and penalties as stored', async () => {
    const tools = await client()
    const arranged = await arrange(database(), 'Scaled detail')
    await tools.call('score_posting', partly(arranged))
    const stored = await storedScore(tools, arranged.postingId)

    const outcome = await tools.call('posting_get', { postingId: arranged.postingId, scale: 'percent' })
    const [detail] = (outcome.body as { scores: Array<{ score: Shown; ratings: Array<{ rating: { coverage: number } }> }> })
      .scores

    expect(detail?.score).toMatchObject(valuesOf(expectedOn(stored, 'percent')))
    expect(detail?.ratings[0]?.rating.coverage).toBe(0.7234)
  })

  test('posting_search scales the score of each row', async () => {
    const tools = await client()
    const arranged = await arrange(database(), 'Scaled search')
    await tools.call('score_posting', partly(arranged))
    const stored = await storedScore(tools, arranged.postingId)

    const outcome = await tools.call('posting_search', {
      companyId: arranged.companyId,
      criteriaSetId: arranged.setId,
      scale: 'stars',
    })
    const [row] = outcome.body as Array<{ score: Shown | null }>

    expect(row?.score).toMatchObject(valuesOf(expectedOn(stored, 'stars')))
  })

  test('criteria_sets shows each apply threshold on the scale asked for', async () => {
    const tools = await client()
    const arranged = await arrange(database(), 'Scaled threshold')

    const outcome = await tools.call('criteria_sets', { scale: 'stars' })
    const set = (outcome.body as Array<{ id: number; applyThreshold: number | null }>).find((row) => row.id === arranged.setId)

    expect(set?.applyThreshold).toBe(2.5)
  })

  test('a scale outside the four, such as a letter grade, is refused at the schema', async () => {
    const tools = await client()
    const arranged = await arrange(database(), 'Scaled grade')

    const outcome = await tools.call('score_history', { postingId: arranged.postingId, scale: 'grade' })

    expect(outcome.failed).toBe(true)
    expect(failureText(outcome)).toContain('scale')
  })
})
