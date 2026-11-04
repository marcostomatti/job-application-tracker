import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import { aggregate } from '../../src/stats/aggregate.ts'
import { readStats } from '../../src/stats/reading.ts'
import type { StatsContext, StatsPosting } from '../../src/stats/types.ts'
import { countBarOption, requirementBarOption, scoreScatterOption, sourceBarOption, type ChartTokens } from '../../src/web/charts/options.ts'
import { StatsView } from '../../src/web/pages/stats.tsx'

const TOKENS: ChartTokens = {
  fg1: '#111',
  fg2: '#333',
  fg3: '#666',
  border: '#ddd',
  surface: '#fff',
  accent: '#0a7',
  neutral: '#357',
  bands: { apply: '#070', ask: '#a70', skip: '#a00', unscored: '#999' },
}

const CONTEXT: StatsContext = {
  criteriaSet: { id: 1, name: 'Example rubric', version: 1, applyThreshold: 0.7 },
  softRequirements: [{ id: 10, key: 'domain', label: 'Domain fit' }],
  askFloor: 0.5,
  scale: 'stars',
}

const POSTINGS: StatsPosting[] = [
  {
    id: 1,
    seenAt: '2026-01-01',
    source: 'Job board',
    stage: { label: 'Applied', sort: 1, phase: 'Active', phaseSort: 1 },
    seniority: { label: 'Mid', sort: 2 },
    summary: { industry: 'Logistics', stack: ['Go'], yearsExperience: 4, condensed: 'Kafka streaming' },
    score: { overall: 0.8, recommendApply: true, gateBlocked: false, softCoverages: [{ requirementId: 10, coverage: 0.9 }] },
  },
  { id: 2, seenAt: '2026-01-02', source: null, stage: null, seniority: null, summary: null, score: null },
]

const stats = aggregate(POSTINGS, CONTEXT)

type Series = { name?: string; data: unknown[]; stack?: string; markLine?: { data: unknown[] } }
const seriesOf = (option: Record<string, unknown>): Series[] => option.series as Series[]

describe('chart options', () => {
  test('the score scatter has one series per scored band, points as [score, count], and the band edges', () => {
    const series = seriesOf(scoreScatterOption(stats, TOKENS))

    expect(series.map((entry) => entry.name)).toEqual(['Apply', 'Ask', 'Skip'])
    expect(series[0]?.data).toEqual([[4, 1]])
    expect(series[0]?.markLine?.data).toEqual([
      { name: 'ask from', xAxis: 2.5 },
      { name: 'apply from', xAxis: 3.5 },
    ])
  })

  test('the source bars stack all four bands, unscored included', () => {
    const series = seriesOf(sourceBarOption(stats, TOKENS))

    expect(series.map((entry) => entry.name)).toEqual(['Apply', 'Ask', 'Skip', 'Unscored'])
    expect(series.every((entry) => entry.stack === 'bands')).toBe(true)
    expect(series[3]?.data).toEqual([0, 1])
  })

  test('requirement bars are percentages, and a requirement with too few ratings is drawn faint', () => {
    const [series] = seriesOf(requirementBarOption(stats, TOKENS))

    expect(series?.data).toEqual([{ value: 90, itemStyle: { color: TOKENS.border } }])
  })

  test('a count bar is the rows in order', () => {
    expect(seriesOf(countBarOption([{ label: 'Go', count: 3 }], TOKENS))[0]?.data).toEqual([3])
  })
})

describe('StatsView', () => {
  test('renders every card with its n and what was not recorded', () => {
    const html = renderToStaticMarkup(<StatsView data={{ stats, reading: readStats(stats) }} tokens={TOKENS} />)

    for (const title of ['Postings by score', 'Postings per source', 'Current stage', 'Criteria: struggling and easiest', 'Industry', 'Stack', 'Loose indicators', 'Common terms', 'Reading for an agent']) {
      expect(html).toContain(title)
    }
    expect(html).toContain('1 postings have no industry in their summary.')
    expect(html).toContain('1 unscored against this set')
    expect(html).toContain('too few to say')
    expect(html).toContain('No shared terms recorded yet.')
  })
})
