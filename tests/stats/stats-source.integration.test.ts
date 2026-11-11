import { beforeAll, describe, expect, test } from 'bun:test'

import { readAskFloor, readStatsSource } from '../../src/data/repositories/stats.ts'
import { statsTools } from '../../src/mcp/tools/stats.ts'
import type { MarketStats } from '../../src/stats/types.ts'
import { connectTools, useSharedScratchDatabase, type ToolClient } from '../mcp/tools/harness.ts'
import { seedStatsExample, type StatsSeed } from './seed.ts'

const database = useSharedScratchDatabase()
let seed: StatsSeed
let tools: ToolClient

beforeAll(async () => {
  seed = await seedStatsExample(database())
  tools = await connectTools(statsTools, database())
})

async function statsOf(args: Record<string, unknown>): Promise<{ stats: MarketStats; reading: string }> {
  const outcome = await tools.call('market_stats', args)
  if (outcome.failed) throw new Error(JSON.stringify(outcome.body))
  return outcome.body as { stats: MarketStats; reading: string }
}

describe('readStatsSource', () => {
  test('reads every posting, and only the latest score against the one set', async () => {
    const source = await readStatsSource(database(), seed.setId)

    expect(source.postings).toHaveLength(9)
    expect(source.postings[0]?.score?.overall).toBe(0.82)
    // The posting scored only against the other set is unscored here.
    expect(source.postings[8]?.score).toBeNull()
  })

  test('a gate rated 0 blocks; a tooling rating of null with a detour counts the detour', async () => {
    const source = await readStatsSource(database(), seed.setId)

    expect(source.postings[4]?.score?.gateBlocked).toBe(true)
    expect(source.postings[7]?.score).toMatchObject({ overall: null, gateBlocked: false })
    const tools = source.postings[6]?.score?.softCoverages.find((entry) => entry.requirementId === source.context.softRequirements[1]?.id)
    expect(tools?.coverage).toBeCloseTo(0.3)
  })

  test('with no set named, the default set is read', async () => {
    expect((await readStatsSource(database())).context.criteriaSet.id).toBe(seed.setId)
  })
})

describe('market_stats', () => {
  test('bands, sources, stages, industries and stack, from the example market on stars', async () => {
    const { stats } = await statsOf({ scale: 'stars' })

    expect(stats.bands).toEqual({ apply: 2, ask: 2, skip: 3, unscored: 2 })
    expect(stats.bandEdges).toEqual({ askFloor: 2.5, applyThreshold: 3.5 })
    expect(stats.scoreDistribution).toEqual({
      points: [
        { score: 1.5, band: 'skip', count: 1 },
        { score: 2.3, band: 'skip', count: 1 },
        { score: 2.8, band: 'ask', count: 1 },
        { score: 3.1, band: 'ask', count: 1 },
        { score: 3.7, band: 'apply', count: 1 },
        { score: 3.9, band: 'skip', count: 1 },
        { score: 4.1, band: 'apply', count: 1 },
      ],
      noOverall: 1,
      unscored: 1,
    })
    expect(stats.bySource).toEqual([
      { source: 'Job board', total: 5, bands: { apply: 2, ask: 1, skip: 1, unscored: 1 } },
      { source: 'Referral', total: 2, bands: { apply: 0, ask: 1, skip: 1, unscored: 0 } },
      { source: 'no source recorded', total: 2, bands: { apply: 0, ask: 0, skip: 1, unscored: 1 } },
    ])
    expect(stats.byStage).toEqual({
      rows: [
        { phase: 'Pipeline', stage: 'Saved', count: 2 },
        { phase: 'Active', stage: 'Applied', count: 1 },
        { phase: 'Active', stage: 'Interview', count: 1 },
      ],
      noStage: 5,
    })
    expect(stats.byIndustry).toEqual({
      rows: [
        { label: 'Logistics', count: 2 },
        { label: 'Retail', count: 2 },
        { label: 'Finance', count: 1 },
      ],
      recorded: 5,
      notRecorded: 4,
    })
    expect(stats.byStack.rows.slice(0, 4).map((row) => row.label)).toEqual(['Go', 'Postgres', 'React', 'TypeScript'])
    expect(stats.byStack).toMatchObject({ recorded: 6, notRecorded: 3 })
  })

  test('soft requirements: null excluded with n, measured zero kept, struggling and easiest named', async () => {
    const { stats } = await statsOf({})

    const [domain, tooling] = stats.requirements.rows
    expect(domain).toMatchObject({ key: 'domain', rated: 7, notRated: 1, tooFew: false })
    expect(domain?.averageCoverage).toBeCloseTo(3.7 / 7)
    expect(tooling).toMatchObject({ key: 'tools', rated: 7, notRated: 1 })
    expect(tooling?.averageCoverage).toBeCloseTo(4 / 7)
    expect(stats.requirements).toMatchObject({ struggling: 'domain', easiest: 'tools', scoredPostings: 8 })
  })

  test('loose indicators: seniority, stored years only, and shared terms', async () => {
    const { stats, reading } = await statsOf({})

    expect(stats.loose.seniority).toMatchObject({ averageLabel: 'Mid', recorded: 7, notRecorded: 2 })
    expect(stats.loose.yearsExperience).toEqual({ average: 5.3, median: 5, n: 4, notRecorded: 5, tooFew: true })
    expect(stats.loose.buzzwords.rows.slice(0, 3)).toEqual([
      { label: 'kubernetes', count: 3 },
      { label: 'terraform', count: 3 },
      { label: 'kafka', count: 2 },
    ])
    expect(reading).toContain('Struggling most: Domain fit')
  })

  test('the other version is a separate read, never mixed in', async () => {
    const { stats } = await statsOf({ criteriaSetId: seed.otherSetId })

    expect(stats.criteriaSet.version).toBe(2)
    expect(stats.bands).toEqual({ apply: 1, ask: 0, skip: 0, unscored: 8 })
  })

  test('the ask floor can be tried per read, and stored by stats_ask_floor_set', async () => {
    const tried = await statsOf({ askFloor: 0.6 })
    const stored = await tools.call('stats_ask_floor_set', { askFloor: 0.3 })
    const after = await statsOf({})

    expect(tried.stats.bands).toEqual({ apply: 2, ask: 1, skip: 4, unscored: 2 })
    expect(stored.body).toEqual({ askFloor: 0.3 })
    expect(await readAskFloor(database())).toBe(0.3)
    expect(after.stats.bands).toEqual({ apply: 2, ask: 4, skip: 1, unscored: 2 })
  })

  test('an unknown criteria set is refused as not found, and a floor above 1 by the schema', async () => {
    expect((await tools.call('market_stats', { criteriaSetId: 999_999 })).failed).toBe(true)
    expect((await tools.call('stats_ask_floor_set', { askFloor: 1.5 })).failed).toBe(true)
  })
})
