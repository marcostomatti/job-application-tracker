import { describe, expect, test } from 'bun:test'

import { aggregate, MIN_N, NO_SOURCE } from '../../src/stats/aggregate.ts'
import { leadBand } from '../../src/stats/bands.ts'
import { buzzwords, termsOf } from '../../src/stats/buzzwords.ts'
import { readStats } from '../../src/stats/reading.ts'
import type { StatsContext, StatsPosting, StatsScore } from '../../src/stats/types.ts'

const CONTEXT: StatsContext = {
  criteriaSet: { id: 1, name: 'Example rubric', version: 2, applyThreshold: 0.7 },
  softRequirements: [
    { id: 10, key: 'domain', label: 'Domain fit' },
    { id: 11, key: 'tools', label: 'Tooling' },
    { id: 12, key: 'rare', label: 'Rarely rated' },
  ],
  askFloor: 0.5,
  scale: 'stars',
}

function score(overall: number | null, extra: Partial<StatsScore> = {}): StatsScore {
  return { overall, recommendApply: false, gateBlocked: false, softCoverages: [], ...extra }
}

let nextId = 1
function posting(fields: Partial<StatsPosting> = {}): StatsPosting {
  return { id: nextId++, seenAt: '2026-01-01', source: null, stage: null, seniority: null, summary: null, score: null, ...fields }
}

describe('leadBand', () => {
  test.each([
    ['no score', null, 'unscored'],
    ['recommended', score(0.8, { recommendApply: true }), 'apply'],
    ['gate-blocked, even above the threshold', score(0.9, { gateBlocked: true }), 'skip'],
    ['gate-blocked in the ask range', score(0.6, { gateBlocked: true }), 'skip'],
    ['from the floor to below the threshold', score(0.5), 'ask'],
    ['just below the floor', score(0.4999), 'skip'],
    ['a measured zero', score(0), 'skip'],
    ['scored with no overall', score(null), 'unscored'],
  ] as const)('%s is %s', (_label, input, band) => {
    expect(leadBand(input, 0.5)).toBe(band)
  })

  test('the ask floor is a setting, not a constant', () => {
    expect(leadBand(score(0.55), 0.6)).toBe('skip')
  })
})

describe('aggregate', () => {
  test('counts every posting in one band, and unscored is never folded into skip', () => {
    const stats = aggregate(
      [
        posting({ score: score(0.8, { recommendApply: true }) }),
        posting({ score: score(0.6) }),
        posting({ score: score(0.2) }),
        posting(),
        posting({ score: score(null) }),
      ],
      CONTEXT,
    )

    expect(stats.postings).toBe(5)
    expect(stats.bands).toEqual({ apply: 1, ask: 1, skip: 1, unscored: 2 })
    expect(stats.scoreDistribution.unscored).toBe(1)
    expect(stats.scoreDistribution.noOverall).toBe(1)
  })

  test('the score chart counts postings per score on the chosen scale, split by band', () => {
    const stats = aggregate(
      [posting({ score: score(0.6) }), posting({ score: score(0.61) }), posting({ score: score(0.6, { gateBlocked: true }) })],
      CONTEXT,
    )

    expect(stats.scoreDistribution.points).toEqual([
      { score: 3, band: 'ask', count: 1 },
      { score: 3, band: 'skip', count: 1 },
      { score: 3.1, band: 'ask', count: 1 },
    ])
    expect(stats.bandEdges).toEqual({ askFloor: 2.5, applyThreshold: 3.5 })
  })

  test('per source, each band is counted, and a posting with no origin has its own row', () => {
    const stats = aggregate(
      [
        posting({ source: 'Job board', score: score(0.8, { recommendApply: true }) }),
        posting({ source: 'Job board', score: score(0.3) }),
        posting({ source: 'Referral' }),
        posting(),
      ],
      CONTEXT,
    )

    expect(stats.bySource).toEqual([
      { source: 'Job board', total: 2, bands: { apply: 1, ask: 0, skip: 1, unscored: 0 } },
      { source: 'Referral', total: 1, bands: { apply: 0, ask: 0, skip: 0, unscored: 1 } },
      { source: NO_SOURCE, total: 1, bands: { apply: 0, ask: 0, skip: 0, unscored: 1 } },
    ])
  })

  test('the current stage is grouped by phase in registry order, with the stageless counted', () => {
    const applied = { label: 'Applied', sort: 1, phase: 'Active', phaseSort: 2 }
    const saved = { label: 'Saved', sort: 0, phase: 'Pipeline', phaseSort: 1 }
    const stats = aggregate([posting({ stage: applied }), posting({ stage: saved }), posting({ stage: applied }), posting()], CONTEXT)

    expect(stats.byStage).toEqual({
      rows: [
        { phase: 'Pipeline', stage: 'Saved', count: 1 },
        { phase: 'Active', stage: 'Applied', count: 2 },
      ],
      noStage: 1,
    })
  })

  test('industry and stack count only what a summary holds; a posting with neither is not recorded', () => {
    const summary = (industry: string | null, stack: string[]) => ({ industry, stack, yearsExperience: null, condensed: '' })
    const stats = aggregate(
      [
        posting({ summary: summary('Logistics', ['TypeScript', 'Postgres']) }),
        posting({ summary: summary(null, ['typescript', 'TypeScript']) }),
        posting({ summary: summary('Logistics', []) }),
        posting(),
      ],
      CONTEXT,
    )

    expect(stats.byIndustry).toEqual({ rows: [{ label: 'Logistics', count: 2 }], recorded: 2, notRecorded: 2 })
    expect(stats.byStack).toEqual({
      rows: [
        { label: 'TypeScript', count: 2 },
        { label: 'Postgres', count: 1 },
      ],
      recorded: 2,
      notRecorded: 2,
    })
  })

  test('requirement averages leave null out with its count, keep a measured zero, and rank only with enough ratings', () => {
    const rated = (domain: number | null, tools: number | null) =>
      posting({
        score: score(0.6, {
          softCoverages: [
            { requirementId: 10, coverage: domain },
            { requirementId: 11, coverage: tools },
          ],
        }),
      })
    const postings = [rated(0, 1), rated(0.2, 1), rated(0.4, 0.8), rated(0.2, 0.9), rated(0.2, 0.8), rated(null, null), posting()]

    const { requirements } = aggregate(postings, CONTEXT)

    const domain = requirements.rows.find((row) => row.key === 'domain')
    expect(domain?.averageCoverage).toBeCloseTo(0.2)
    expect(domain).toMatchObject({ rated: 5, notRated: 1, tooFew: false })
    expect(requirements.rows.find((row) => row.key === 'rare')).toMatchObject({ averageCoverage: null, rated: 0, tooFew: true })
    expect(requirements.struggling).toBe('domain')
    expect(requirements.easiest).toBe('tools')
    expect(requirements.scoredPostings).toBe(6)
  })

  test(`with fewer than ${MIN_N} ratings, nothing is ranked`, () => {
    const one = posting({ score: score(0.6, { softCoverages: [{ requirementId: 10, coverage: 0.5 }] }) })

    const { requirements } = aggregate([one], CONTEXT)

    expect(requirements.struggling).toBeNull()
    expect(requirements.easiest).toBeNull()
  })

  test('seniority averages to the nearest stored label; years of experience only from the stored field', () => {
    const junior = { label: 'Junior', sort: 1 }
    const senior = { label: 'Senior', sort: 3 }
    const mid = { label: 'Mid', sort: 2 }
    const withYears = (years: number | null) => ({ industry: null, stack: [], yearsExperience: years, condensed: '' })
    const stats = aggregate(
      [posting({ seniority: junior, summary: withYears(2) }), posting({ seniority: senior, summary: withYears(6) }), posting({ seniority: mid, summary: withYears(null) }), posting()],
      CONTEXT,
    )

    expect(stats.loose.seniority.averageLabel).toBe('Mid')
    expect(stats.loose.seniority.notRecorded).toBe(1)
    expect(stats.loose.yearsExperience).toEqual({ average: 4, median: 4, n: 2, notRecorded: 2, tooFew: true })
  })

  test('the reading states counts and n, and says what is not recorded', () => {
    const stats = aggregate([posting({ source: 'Job board', score: score(0.6) }), posting()], CONTEXT)

    const reading = readStats(stats)

    expect(reading).toContain('2 postings against "Example rubric" v2: 0 apply, 1 ask, 0 skip, 1 unscored')
    expect(reading).toContain('ask starts at 2.5 of 5, apply at 3.5 of 5')
    expect(reading).toContain('No summary records a stack yet.')
    expect(reading).toContain('years of experience')
  })

  test('with no threshold, the reading says nothing can be recommended', () => {
    const stats = aggregate([], { ...CONTEXT, criteriaSet: { ...CONTEXT.criteriaSet, applyThreshold: null } })

    expect(readStats(stats)).toContain('no apply threshold')
  })
})

describe('buzzwords', () => {
  test('counts a term once per text, drops stopwords and terms used by one text only', () => {
    const texts = ['Kubernetes and Kubernetes clusters, with Terraform.', 'Terraform modules on kubernetes.', 'Distributed systems.']

    expect(buzzwords(texts)).toEqual([
      { label: 'kubernetes', count: 2 },
      { label: 'terraform', count: 2 },
    ])
  })

  test('keeps tech spellings like c++, c# and node.js, and drops bare numbers', () => {
    expect([...termsOf('C++ and C# with Node.js in 2026.')]).toEqual(['c++', 'c#', 'node.js'])
  })
})
