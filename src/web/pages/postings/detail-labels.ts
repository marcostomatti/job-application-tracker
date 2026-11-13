/**
 * Pure label and format helpers for the posting detail panel. Nothing here fetches or renders, so a
 * test can pin every wording without a server or a DOM.
 */
import { leadBand } from '../../../stats/bands.ts'
import type { LeadBand } from '../../../stats/types.ts'
import { toScale } from '../../../scoring/scale.ts'
import type { PostingDetail, RequirementRow } from '../../data.ts'

type ScoreDetail = PostingDetail['scores'][number]
type Posting = PostingDetail['posting']

/** A timestamp as JSON carries it (a string) or as the server type names it (a Date). */
export type Instant = Date | string | null | undefined

/** The day part of an instant, as `YYYY-MM-DD`, or an em dash when there is none. */
export function formatDay(value: Instant): string {
  if (value === null || value === undefined || value === '') return '—'
  const date = typeof value === 'string' ? new Date(value) : value
  if (Number.isNaN(date.getTime())) return typeof value === 'string' ? value : '—'
  return date.toISOString().slice(0, 10)
}

/** A ratio from 0 to 1 as a whole percent; null is not measured, which reads as a dash and never as 0%. */
export function formatPercent(ratio: number | null | undefined): string {
  if (ratio === null || ratio === undefined) return '—'
  return `${Math.round(ratio * 100)}%`
}

/** A stored overall as stars and percent, so it reads the same as the stats page. */
export function formatOverall(overall: number | null): string {
  if (overall === null) return 'not scored'
  return `${toScale(overall, 'stars').toFixed(1)} / 5 (${formatPercent(overall)})`
}

/** A weight as stored, or a dash when the requirement carries none. */
export function formatWeight(weight: number | null | undefined): string {
  if (weight === null || weight === undefined) return '—'
  return String(Number(weight.toFixed(2)))
}

/** A penalty amount (stored as zero or below) with its sign, to two decimals. */
export function formatPenalty(amount: number): string {
  const fixed = Math.abs(amount).toFixed(2)
  return amount < 0 ? `−${fixed}` : fixed
}

/** City and country joined, or null when neither is recorded. */
export function locationLine(city: string | null, country: string | null): string | null {
  const parts = [city, country].filter((part): part is string => part !== null && part.trim() !== '')
  return parts.length === 0 ? null : parts.join(', ')
}

export interface PostingLink {
  readonly href: string
  readonly label: string
}

const WEB_URL = /^https?:\/\/\S+$/i
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * The `url` a summary's free-form `extra` holds, when it is a web address. `extra` is JSON with
 * no CHECK on its shape, and some writers stored the object as JSON text, so text that parses to
 * an object is read the same way. Anything else holds no url.
 */
function extraUrl(extra: unknown): string | null {
  let value = extra
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return null
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const url = (value as Record<string, unknown>).url
  return typeof url === 'string' && WEB_URL.test(url.trim()) ? url.trim() : null
}

/**
 * Where the user goes to read or apply for the role. The posting has no URL column, so a link
 * exists only when the posting key, the summary's `extra.url` or the apply contact is itself a
 * web address, or the contact is an email address. Inert by construction: this returns an href
 * for an anchor the user clicks; nothing in the panel requests it.
 */
export function postingLink(posting: Pick<Posting, 'postingKey' | 'applyContact'>, summaryExtra?: unknown): PostingLink | null {
  const key = posting.postingKey.trim()
  if (WEB_URL.test(key)) return { href: key, label: 'Open posting' }
  const fromSummary = extraUrl(summaryExtra)
  if (fromSummary !== null) return { href: fromSummary, label: 'Open posting' }
  const contact = (posting.applyContact ?? '').trim()
  if (WEB_URL.test(contact)) return { href: contact, label: 'Apply page' }
  if (EMAIL.test(contact)) return { href: `mailto:${encodeURIComponent(contact).replace('%40', '@')}`, label: 'Apply by email' }
  return null
}

/**
 * The latest of the posting's scores: the read holds one per criteria set that is not superseded,
 * so the newest by day (then id) is the one the panel leads with.
 */
export function latestScore(scores: readonly ScoreDetail[]): ScoreDetail | null {
  let latest: ScoreDetail | null = null
  for (const entry of scores) {
    if (latest === null) {
      latest = entry
      continue
    }
    const newer =
      entry.score.scoredAt > latest.score.scoredAt || (entry.score.scoredAt === latest.score.scoredAt && entry.score.id > latest.score.id)
    if (newer) latest = entry
  }
  return latest
}

export type GateState = 'pass' | 'block' | 'unrated'

/**
 * How a gate stands on one rating. A gate rated 0 blocks; an unrated gate is not measured, so it
 * neither passes nor blocks. A soft requirement has no gate state. This reads the direct coverage
 * only: the detail read carries no detour coverages, so a gate a detour lifts still reads blocked.
 */
export function gateState(kind: string | undefined, coverage: number | null): GateState | null {
  if (kind !== 'gate') return null
  if (coverage === null) return 'unrated'
  return coverage <= 0 ? 'block' : 'pass'
}

export const GATE_LABELS: Readonly<Record<GateState, string>> = { pass: 'passes', block: 'blocks', unrated: 'not rated' }

export interface BreakdownRow {
  readonly requirementId: number
  readonly label: string
  readonly key: string
  readonly kind: string | null
  readonly coverage: number | null
  readonly weight: number | null
  readonly gate: GateState | null
  readonly confidence: string
  readonly evidence: string | null
}

/**
 * One row per rating of a score, joined to its requirement for kind and weight, in the set's own
 * order when the requirements are known. A rating whose requirement was not loaded keeps its label
 * and reads with no kind and no weight.
 */
export function breakdownRows(score: ScoreDetail, requirements: readonly RequirementRow[]): BreakdownRow[] {
  const byId = new Map(requirements.map((row) => [row.id, row]))
  const order = new Map(requirements.map((row, index) => [row.id, index]))
  const rows = score.ratings.map((entry): BreakdownRow => {
    const requirement = byId.get(entry.rating.requirementId)
    return {
      requirementId: entry.rating.requirementId,
      label: entry.requirementLabel,
      key: entry.requirementKey,
      kind: requirement?.kind ?? null,
      coverage: entry.rating.coverage,
      weight: requirement?.weight ?? null,
      gate: gateState(requirement?.kind, entry.rating.coverage),
      confidence: entry.rating.confidence,
      evidence: entry.rating.evidence,
    }
  })
  const rank = (id: number): number => order.get(id) ?? Number.MAX_SAFE_INTEGER
  return [...rows].sort((a, b) => rank(a.requirementId) - rank(b.requirementId))
}

/** The lead band of a score, by the same rule as the stats page (`leadBand`), from the breakdown's gates. */
export function scoreBand(score: ScoreDetail | null, rows: readonly BreakdownRow[], askFloor: number): LeadBand {
  if (score === null) return 'unscored'
  return leadBand(
    {
      overall: score.score.overall,
      recommendApply: score.score.recommendApply,
      gateBlocked: rows.some((row) => row.gate === 'block'),
      softCoverages: [],
    },
    askFloor,
  )
}

const DISPOSITION_LABELS: Readonly<Record<string, string>> = { set_aside: 'Set aside', rejected: 'Rejected' }

/** A disposition's kind as words; an unknown kind is shown as stored rather than hidden. */
export function dispositionLabel(kind: string): string {
  return DISPOSITION_LABELS[kind] ?? kind
}

/**
 * A `<input type="date">` value as the ISO instant the stage route takes, at local noon so the day
 * does not shift across a time zone. Empty means "now", which the server stamps.
 */
export function dateInputToInstant(value: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined
  const local = new Date(`${value}T12:00:00`)
  return Number.isNaN(local.getTime()) ? undefined : local.toISOString()
}

/** Trimmed text, or undefined when nothing is left: a blank note or answer says nothing. */
export function trimmedOrUndefined(value: string): string | undefined {
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}
