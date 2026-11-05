import type { EChartsCoreOption } from 'echarts/core'

import type { LeadBand, MarketStats } from '../../stats/types.ts'

/**
 * Chart options as pure functions of the data and the resolved colour tokens, the pattern the
 * atlas charts package uses: ECharts cannot read CSS variables, so the page resolves them once and
 * every builder is testable with no DOM.
 */
export interface ChartTokens {
  readonly fg1: string
  readonly fg2: string
  readonly fg3: string
  readonly border: string
  readonly surface: string
  readonly accent: string
  /** The colour of a plain count, apart from every band colour. */
  readonly neutral: string
  readonly bands: Readonly<Record<LeadBand, string>>
}

export const BAND_ORDER: readonly LeadBand[] = ['apply', 'ask', 'skip', 'unscored']
export const BAND_LABELS: Readonly<Record<LeadBand, string>> = { apply: 'Apply', ask: 'Ask', skip: 'Skip', unscored: 'Unscored' }

const FONT = 'ui-sans-serif, system-ui, -apple-system, sans-serif'

function base(tokens: ChartTokens): EChartsCoreOption {
  return {
    textStyle: { fontFamily: FONT, color: tokens.fg2 },
    animationDuration: 300,
    tooltip: { trigger: 'item', backgroundColor: tokens.surface, borderColor: tokens.border, textStyle: { color: tokens.fg1 } },
    legend: { top: 0, textStyle: { color: tokens.fg2 }, itemWidth: 12, itemHeight: 12 },
  }
}

function axis(tokens: ChartTokens, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    axisLine: { lineStyle: { color: tokens.border } },
    axisLabel: { color: tokens.fg3 },
    splitLine: { lineStyle: { color: tokens.border, type: 'dashed' } },
    ...extra,
  }
}

/** Item 1: how many postings sit at each score, one series per band, with the band edges drawn. */
export function scoreScatterOption(stats: MarketStats, tokens: ChartTokens): EChartsCoreOption {
  const max = stats.scale === 'ratio' ? 1 : stats.scale === 'stars' ? 5 : stats.scale === 'percent' ? 100 : 10
  const edges = [
    { name: 'ask from', xAxis: stats.bandEdges.askFloor },
    ...(stats.bandEdges.applyThreshold === null ? [] : [{ name: 'apply from', xAxis: stats.bandEdges.applyThreshold }]),
  ]
  const bands = BAND_ORDER.filter((band) => band !== 'unscored')
  return {
    ...base(tokens),
    grid: { left: 40, right: 16, top: 56, bottom: 32 },
    xAxis: axis(tokens, { type: 'value', min: 0, max, name: `score (${stats.scale})`, nameLocation: 'middle', nameGap: 24 }),
    yAxis: axis(tokens, { type: 'value', minInterval: 1, name: 'postings' }),
    series: bands.map((band, index) => ({
      name: BAND_LABELS[band],
      type: 'scatter',
      color: tokens.bands[band],
      symbolSize: (value: [number, number]) => 8 + Math.sqrt(value[1]) * 6,
      data: stats.scoreDistribution.points.filter((point) => point.band === band).map((point) => [point.score, point.count]),
      ...(index === 0 ? { markLine: { silent: true, symbol: 'none', lineStyle: { color: tokens.fg3, type: 'dashed' }, label: { color: tokens.fg3, formatter: '{b}', position: 'insideEndTop' }, data: edges } } : {}),
    })),
  }
}

/** Item 2: postings per source, stacked by lead band. */
export function sourceBarOption(stats: MarketStats, tokens: ChartTokens): EChartsCoreOption {
  return {
    ...base(tokens),
    tooltip: { ...(base(tokens).tooltip as object), trigger: 'axis', axisPointer: { type: 'shadow' } },
    grid: { left: 8, right: 16, top: 36, bottom: 8, containLabel: true },
    xAxis: axis(tokens, { type: 'value', minInterval: 1 }),
    yAxis: axis(tokens, { type: 'category', inverse: true, data: stats.bySource.map((row) => row.source) }),
    series: BAND_ORDER.map((band) => ({
      name: BAND_LABELS[band],
      type: 'bar',
      stack: 'bands',
      color: tokens.bands[band],
      barMaxWidth: 28,
      data: stats.bySource.map((row) => row.bands[band]),
    })),
  }
}

/** A plain horizontal bar of labelled counts, for stages, industries and stack tags. */
export function countBarOption(rows: readonly { label: string; count: number }[], tokens: ChartTokens, color: string = tokens.neutral): EChartsCoreOption {
  return {
    ...base(tokens),
    legend: { show: false },
    tooltip: { ...(base(tokens).tooltip as object), trigger: 'axis', axisPointer: { type: 'shadow' } },
    grid: { left: 8, right: 24, top: 8, bottom: 8, containLabel: true },
    xAxis: axis(tokens, { type: 'value', minInterval: 1 }),
    yAxis: axis(tokens, { type: 'category', inverse: true, data: rows.map((row) => row.label) }),
    series: [{ type: 'bar', color, barMaxWidth: 22, data: rows.map((row) => row.count), label: { show: true, position: 'right', color: tokens.fg2 } }],
  }
}

/** Item 5: average coverage per soft requirement, as a percentage; too-few rows are drawn faint. */
export function requirementBarOption(stats: MarketStats, tokens: ChartTokens): EChartsCoreOption {
  const { rows, struggling, easiest } = stats.requirements
  const colorOf = (key: string, tooFew: boolean): string =>
    tooFew ? tokens.border : key === struggling ? tokens.bands.skip : key === easiest ? tokens.bands.apply : tokens.neutral
  return {
    ...base(tokens),
    legend: { show: false },
    tooltip: { ...(base(tokens).tooltip as object), trigger: 'axis', axisPointer: { type: 'shadow' } },
    grid: { left: 8, right: 48, top: 8, bottom: 8, containLabel: true },
    xAxis: axis(tokens, { type: 'value', min: 0, max: 100, axisLabel: { color: tokens.fg3, formatter: '{value}%' } }),
    yAxis: axis(tokens, { type: 'category', inverse: true, data: rows.map((row) => `${row.label} (n=${row.rated})`) }),
    series: [
      {
        type: 'bar',
        barMaxWidth: 22,
        data: rows.map((row) => ({
          value: row.averageCoverage === null ? null : Math.round(row.averageCoverage * 100),
          itemStyle: { color: colorOf(row.key, row.tooFew) },
        })),
        label: { show: true, position: 'right', color: tokens.fg2, formatter: '{c}%' },
      },
    ],
  }
}

/** The stage rows as bar labels, phase first, so the bars read in pipeline order. */
export function stageRows(stats: MarketStats): { label: string; count: number }[] {
  return stats.byStage.rows.map((row) => ({ label: `${row.phase} · ${row.stage}`, count: row.count }))
}
