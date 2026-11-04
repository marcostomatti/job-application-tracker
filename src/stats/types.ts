import type { Scale } from '../scoring/scale.ts'

/** The lead bands a scored posting falls in; `unscored` is a group of its own and is never folded into `skip`. */
export const LEAD_BANDS = ['apply', 'ask', 'skip', 'unscored'] as const
export type LeadBand = (typeof LEAD_BANDS)[number]

/** One soft requirement's effective coverage on a posting's latest score; `null` is not measured. */
export interface RequirementCoverage {
  readonly requirementId: number
  readonly coverage: number | null
}

/** A posting's latest score against the one criteria set the stats are read for. */
export interface StatsScore {
  readonly overall: number | null
  readonly recommendApply: boolean
  /** A gate of the set was rated and its effective coverage is 0. An unrated gate is not measured, so not blocked. */
  readonly gateBlocked: boolean
  readonly softCoverages: readonly RequirementCoverage[]
}

/** What the stats read of one posting. Every field is as stored; nothing is inferred. */
export interface StatsPosting {
  readonly id: number
  readonly seenAt: string
  /** The route of the posting's first touch, or `null` when no origin is recorded. */
  readonly source: string | null
  readonly stage: { readonly label: string; readonly sort: number; readonly phase: string | null; readonly phaseSort: number } | null
  readonly seniority: { readonly label: string; readonly sort: number } | null
  /** Present only when a summary is stored. */
  readonly summary: {
    readonly industry: string | null
    readonly stack: readonly string[]
    readonly yearsExperience: number | null
    readonly condensed: string
  } | null
  /** `null` when the posting has no score against the set. */
  readonly score: StatsScore | null
}

export interface StatsRequirement {
  readonly id: number
  readonly key: string
  readonly label: string
}

/** Which set the stats are read against, and how they are shown. */
export interface StatsContext {
  readonly criteriaSet: { readonly id: number; readonly name: string; readonly version: number; readonly applyThreshold: number | null }
  readonly softRequirements: readonly StatsRequirement[]
  /** The ratio the `ask` band starts at. */
  readonly askFloor: number
  readonly scale: Scale
}

export interface CountRow {
  readonly label: string
  readonly count: number
}

/** A count over postings where a field may be absent: the absent ones are counted, never dropped. */
export interface Recorded<T> {
  readonly rows: readonly T[]
  /** Postings where the field is stored. */
  readonly recorded: number
  /** Postings where it is not; they are left out of `rows`. */
  readonly notRecorded: number
}

export interface ScorePoint {
  /** The overall on the chosen scale. */
  readonly score: number
  readonly band: Exclude<LeadBand, 'unscored'>
  readonly count: number
}

export interface SourceRow {
  readonly source: string
  readonly total: number
  readonly bands: Readonly<Record<LeadBand, number>>
}

export interface StageRow {
  readonly phase: string
  readonly stage: string
  readonly count: number
}

export interface RequirementRow {
  readonly key: string
  readonly label: string
  /** The average effective coverage, a ratio (coverage is never scaled), or `null` when no score rated it. */
  readonly averageCoverage: number | null
  readonly rated: number
  readonly notRated: number
  /** Fewer ratings than `MIN_N`, so the average is shown but not ranked. */
  readonly tooFew: boolean
}

export interface MarketStats {
  readonly criteriaSet: { readonly id: number; readonly name: string; readonly version: number; readonly applyThreshold: number | null }
  readonly scale: Scale
  /** The ask floor and the apply threshold on `scale`, so a chart can draw the band edges. */
  readonly bandEdges: { readonly askFloor: number; readonly applyThreshold: number | null }
  readonly minN: number
  readonly postings: number
  readonly bands: Readonly<Record<LeadBand, number>>
  readonly scoreDistribution: {
    readonly points: readonly ScorePoint[]
    /** Scored, but the overall is null (no weighted requirement was rated): not on the chart, counted here. */
    readonly noOverall: number
    readonly unscored: number
  }
  readonly bySource: readonly SourceRow[]
  readonly byStage: { readonly rows: readonly StageRow[]; readonly noStage: number }
  readonly byIndustry: Recorded<CountRow>
  readonly byStack: Recorded<CountRow>
  readonly requirements: {
    readonly rows: readonly RequirementRow[]
    /** The ranked requirement with the lowest average, among those with at least `minN` ratings. */
    readonly struggling: string | null
    /** The ranked requirement with the highest average. */
    readonly easiest: string | null
    readonly scoredPostings: number
  }
  readonly loose: {
    readonly seniority: Recorded<CountRow> & { readonly averageLabel: string | null; readonly tooFew: boolean }
    readonly yearsExperience: { readonly average: number | null; readonly median: number | null; readonly n: number; readonly notRecorded: number; readonly tooFew: boolean }
    readonly buzzwords: Recorded<CountRow>
  }
}
