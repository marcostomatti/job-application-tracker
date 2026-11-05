import { toScale } from '../scoring/scale.ts'
import { leadBand } from './bands.ts'
import { buzzwords } from './buzzwords.ts'
import {
  LEAD_BANDS,
  type CountRow,
  type LeadBand,
  type MarketStats,
  type Recorded,
  type RequirementRow,
  type ScorePoint,
  type SourceRow,
  type StageRow,
  type StatsContext,
  type StatsPosting,
} from './types.ts'

/** Below this many, an average or a ranking is shown with its n and marked "too few to say" (spec §10.1). */
export const MIN_N = 5

/** The source label for a posting whose first touch was never recorded. */
export const NO_SOURCE = 'no source recorded'

/** The phase label for a stage that belongs to no phase. */
export const NO_PHASE = 'no phase'

const emptyBands = (): Record<LeadBand, number> => Object.fromEntries(LEAD_BANDS.map((band) => [band, 0])) as Record<LeadBand, number>

/** Rows sorted by count, most first, ties alphabetical, so a reading is stable. */
function byCount(counts: ReadonlyMap<string, number>): CountRow[] {
  return [...counts].sort(([a, x], [b, y]) => y - x || a.localeCompare(b)).map(([label, count]) => ({ label, count }))
}

function tally(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1)
}

function scoreDistribution(postings: readonly StatsPosting[], bands: readonly LeadBand[], context: StatsContext): MarketStats['scoreDistribution'] {
  const points = new Map<string, ScorePoint>()
  let noOverall = 0
  let unscored = 0
  postings.forEach((posting, index) => {
    const band = bands[index] ?? 'unscored'
    if (posting.score === null) return void (unscored += 1)
    if (posting.score.overall === null) return void (noOverall += 1)
    if (band === 'unscored') return
    const score = toScale(posting.score.overall, context.scale)
    const key = `${score}|${band}`
    const found = points.get(key)
    points.set(key, { score, band, count: (found?.count ?? 0) + 1 })
  })
  return { points: [...points.values()].sort((a, b) => a.score - b.score || a.band.localeCompare(b.band)), noOverall, unscored }
}

function bySource(postings: readonly StatsPosting[], bands: readonly LeadBand[]): SourceRow[] {
  const rows = new Map<string, Record<LeadBand, number>>()
  postings.forEach((posting, index) => {
    const source = posting.source ?? NO_SOURCE
    const counts = rows.get(source) ?? emptyBands()
    counts[bands[index] ?? 'unscored'] += 1
    rows.set(source, counts)
  })
  return [...rows]
    .map(([source, counts]) => ({ source, bands: counts, total: LEAD_BANDS.reduce((sum, band) => sum + counts[band], 0) }))
    .sort((a, b) => Number(a.source === NO_SOURCE) - Number(b.source === NO_SOURCE) || b.total - a.total || a.source.localeCompare(b.source))
}

function byStage(postings: readonly StatsPosting[]): MarketStats['byStage'] {
  const rows = new Map<string, StageRow & { order: [number, number] }>()
  let noStage = 0
  for (const posting of postings) {
    const stage = posting.stage
    if (stage === null) {
      noStage += 1
      continue
    }
    const phase = stage.phase ?? NO_PHASE
    const key = `${phase}\u0000${stage.label}`
    const found = rows.get(key)
    rows.set(key, { phase, stage: stage.label, count: (found?.count ?? 0) + 1, order: [stage.phaseSort, stage.sort] })
  }
  const ordered = [...rows.values()].sort((a, b) => a.order[0] - b.order[0] || a.order[1] - b.order[1] || a.stage.localeCompare(b.stage))
  return { rows: ordered.map(({ phase, stage, count }) => ({ phase, stage, count })), noStage }
}

/** Counts a summary field over the postings that have it; the rest are counted as not recorded. */
function recordedCounts(postings: readonly StatsPosting[], pick: (posting: StatsPosting) => readonly string[] | null): Recorded<CountRow> {
  const counts = new Map<string, number>()
  /** A tag's first spelling, keyed case-insensitively, so `React` and `react` are one row. */
  const spelling = new Map<string, string>()
  let recorded = 0
  for (const posting of postings) {
    const values = pick(posting)
    if (values === null || values.length === 0) continue
    recorded += 1
    const seen = new Set<string>()
    for (const raw of values) {
      const label = raw.trim()
      const key = label.toLowerCase()
      if (label === '' || seen.has(key)) continue
      seen.add(key)
      if (!spelling.has(key)) spelling.set(key, label)
      tally(counts, key)
    }
  }
  const rows = byCount(counts).map((row) => ({ label: spelling.get(row.label) ?? row.label, count: row.count }))
  return { rows, recorded, notRecorded: postings.length - recorded }
}

function requirementRows(postings: readonly StatsPosting[], context: StatsContext): MarketStats['requirements'] {
  const scored = postings.filter((posting) => posting.score !== null)
  const rows: RequirementRow[] = context.softRequirements.map((requirement) => {
    let sum = 0
    let rated = 0
    for (const posting of scored) {
      const coverage = posting.score?.softCoverages.find((entry) => entry.requirementId === requirement.id)?.coverage ?? null
      if (coverage === null) continue
      sum += coverage
      rated += 1
    }
    return {
      key: requirement.key,
      label: requirement.label,
      averageCoverage: rated === 0 ? null : sum / rated,
      rated,
      notRated: scored.length - rated,
      tooFew: rated < MIN_N,
    }
  })
  const ranked = rows.filter((row) => !row.tooFew && row.averageCoverage !== null)
  const sorted = [...ranked].sort((a, b) => (a.averageCoverage ?? 0) - (b.averageCoverage ?? 0) || a.key.localeCompare(b.key))
  const struggling = sorted[0]?.key ?? null
  const easiest = sorted.length > 1 ? (sorted.at(-1)?.key ?? null) : null
  return { rows, struggling, easiest, scoredPostings: scored.length }
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? (sorted[middle] ?? null) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
}

function seniority(postings: readonly StatsPosting[]): MarketStats['loose']['seniority'] {
  const counts = recordedCounts(postings, (posting) => (posting.seniority === null ? null : [posting.seniority.label]))
  const sorts = postings.flatMap((posting) => (posting.seniority === null ? [] : [posting.seniority]))
  if (sorts.length === 0) return { ...counts, averageLabel: null, tooFew: true }
  const average = sorts.reduce((sum, entry) => sum + entry.sort, 0) / sorts.length
  // The seniority whose `sort` is nearest the mean; a seniority is a label, so its average is one too.
  const nearest = [...sorts].sort((a, b) => Math.abs(a.sort - average) - Math.abs(b.sort - average) || a.sort - b.sort)[0]
  return { ...counts, averageLabel: nearest?.label ?? null, tooFew: sorts.length < MIN_N }
}

function yearsExperience(postings: readonly StatsPosting[]): MarketStats['loose']['yearsExperience'] {
  const values = postings.flatMap((posting) => (posting.summary?.yearsExperience == null ? [] : [posting.summary.yearsExperience]))
  const average = values.length === 0 ? null : Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10
  return { average, median: median(values), n: values.length, notRecorded: postings.length - values.length, tooFew: values.length < MIN_N }
}

/**
 * Every aggregate of the stats page, from postings as stored, against one criteria set.
 *
 * Nothing is inferred: a field a summary does not hold is counted as not recorded and left out of
 * the rows. Scores from other sets are never in `postings` (the query reads one set), so one
 * series never mixes two rubrics. A `null` coverage is not measured and is left out of an average,
 * with its count; a `0` is a measured zero and is in it.
 */
export function aggregate(postings: readonly StatsPosting[], context: StatsContext): MarketStats {
  const bands = postings.map((posting) => leadBand(posting.score, context.askFloor))
  const bandTotals = emptyBands()
  for (const band of bands) bandTotals[band] += 1

  const set = context.criteriaSet
  return {
    criteriaSet: { ...set, applyThreshold: set.applyThreshold === null ? null : toScale(set.applyThreshold, context.scale) },
    scale: context.scale,
    bandEdges: {
      askFloor: toScale(context.askFloor, context.scale),
      applyThreshold: set.applyThreshold === null ? null : toScale(set.applyThreshold, context.scale),
    },
    minN: MIN_N,
    postings: postings.length,
    bands: bandTotals,
    scoreDistribution: scoreDistribution(postings, bands, context),
    bySource: bySource(postings, bands),
    byStage: byStage(postings),
    byIndustry: recordedCounts(postings, (posting) => (posting.summary?.industry ? [posting.summary.industry] : null)),
    byStack: recordedCounts(postings, (posting) => posting.summary?.stack ?? null),
    requirements: requirementRows(postings, context),
    loose: {
      seniority: seniority(postings),
      yearsExperience: yearsExperience(postings),
      buzzwords: (() => {
        const texts = postings.flatMap((posting) => (posting.summary === null ? [] : [posting.summary.condensed]))
        return { rows: buzzwords(texts), recorded: texts.length, notRecorded: postings.length - texts.length }
      })(),
    },
  }
}
