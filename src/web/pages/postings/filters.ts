/**
 * The postings and board pages' state and its pure functions: the URL query and back, the
 * filters, the grid's sort and the board's column order. Pure so the semantics are tested
 * without a render, and so both pages read the same filters the same way.
 */
import { LEAD_BANDS, type LeadBand } from '../../../stats/types.ts'
import type { PhaseRegistryRow, PostingListRow, RecommendationDisplay } from '../../data.ts'
import { bandRank, DEFAULT_DISPLAY, primaryBand } from './recommendation.ts'

export { BAND_LABELS, BAND_ORDER } from '../../charts/options.ts'

/** The phase filter: a phase id, `none` for rows with no stage yet, or `null` for every phase. */
export type PhaseFilter = number | 'none' | null

export interface PostingFilters {
  readonly search: string
  readonly phase: PhaseFilter
  readonly band: LeadBand | null
  /** Set-aside postings are left out unless this is on; the server reads it as `setAside=include`. */
  readonly includeSetAside: boolean
  /** The criteria set the scores are read under; `null` is the server's default set. */
  readonly criteriaSetId: number | null
  /** Board only: skip postings are left off the board unless this is on. The postings table ignores it. */
  readonly showSkip: boolean
}

export const EMPTY_FILTERS: PostingFilters = { search: '', phase: null, band: null, includeSetAside: false, criteriaSetId: null, showSkip: false }

export type SortKey = 'company' | 'role' | 'phase' | 'score' | 'recommendation' | 'seen' | 'updated'
export const SORT_KEYS: readonly SortKey[] = ['company', 'role', 'phase', 'score', 'recommendation', 'seen', 'updated']

/** Sort keys an older link may carry, read as the column that replaced them. */
const SORT_ALIASES: Readonly<Record<string, SortKey>> = { apply: 'recommendation' }

export interface GridSort {
  readonly key: SortKey
  readonly desc: boolean
}

/** Newest seen first: the order the server returns, so an unsorted grid and a sorted one agree. */
export const DEFAULT_SORT: GridSort = { key: 'seen', desc: true }

/** The whole page as the URL holds it. */
export interface PostingsUrlState {
  readonly posting: number | null
  readonly filters: PostingFilters
  readonly sort: GridSort
}

export const DEFAULT_URL_STATE: PostingsUrlState = { posting: null, filters: EMPTY_FILTERS, sort: DEFAULT_SORT }

const POSITIVE_INT = /^[1-9]\d*$/

function positiveInt(raw: string | null): number | null {
  return raw !== null && POSITIVE_INT.test(raw) ? Number(raw) : null
}

function oneOf<T extends string>(raw: string | null, allowed: readonly T[]): T | null {
  return allowed.includes(raw as T) ? (raw as T) : null
}

function phaseFilter(raw: string | null): PhaseFilter {
  return raw === 'none' ? 'none' : positiveInt(raw)
}

/** `<key>:asc` or `<key>:desc`; anything else is the default order. */
function gridSort(raw: string | null): GridSort {
  const [key, direction] = (raw ?? '').split(':')
  const sortKey = oneOf(SORT_ALIASES[key ?? ''] ?? key ?? null, SORT_KEYS)
  if (sortKey === null || (direction !== 'asc' && direction !== 'desc')) return DEFAULT_SORT
  return { key: sortKey, desc: direction === 'desc' }
}

/**
 * The page state read from a query string. Each field falls back to its default on its own, so
 * a kept link with one unreadable value still opens a usable page.
 */
export function decodeUrlState(search: string): PostingsUrlState {
  const params = new URLSearchParams(search)
  return {
    posting: positiveInt(params.get('posting')),
    sort: gridSort(params.get('sort')),
    filters: {
      search: params.get('q') ?? '',
      phase: phaseFilter(params.get('phase')),
      band: oneOf(params.get('band'), LEAD_BANDS),
      includeSetAside: params.get('aside') === '1',
      criteriaSetId: positiveInt(params.get('set')),
      showSkip: params.get('skip') === '1',
    },
  }
}

/** The query string for a page state, defaults left out; `''` when everything is default. */
export function encodeUrlState(state: PostingsUrlState): string {
  const params = new URLSearchParams()
  const { filters, sort } = state
  if (filters.search !== '') params.set('q', filters.search)
  if (filters.phase !== null) params.set('phase', String(filters.phase))
  if (filters.band !== null) params.set('band', filters.band)
  if (filters.includeSetAside) params.set('aside', '1')
  if (filters.criteriaSetId !== null) params.set('set', String(filters.criteriaSetId))
  if (filters.showSkip) params.set('skip', '1')
  if (sort.key !== DEFAULT_SORT.key || sort.desc !== DEFAULT_SORT.desc) params.set('sort', `${sort.key}:${sort.desc ? 'desc' : 'asc'}`)
  if (state.posting !== null) params.set('posting', String(state.posting))
  const query = params.toString()
  return query === '' ? '' : `?${query}`
}

/**
 * The band a row is filtered, sorted and coloured by: the server's recommendation (the rules band
 * is gate-aware and uses the configured ask floor), read through the display choice, so under
 * `agent` it is the agent's verdict where there is one.
 */
export function bandOf(row: PostingListRow, display: RecommendationDisplay = DEFAULT_DISPLAY): LeadBand {
  return primaryBand(row.recommendation, display)
}

/** Folded so a search without accents finds a name with them, whatever the case. */
export function fold(value: string): string {
  return value.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

function haystack(row: PostingListRow): string {
  const { posting, company, stage, phase } = row
  return fold([company.name, posting.roleTitle, posting.city ?? '', posting.country ?? '', stage?.label ?? '', phase?.label ?? ''].join(' \u0000 '))
}

function matchesPhase(row: PostingListRow, phase: PhaseFilter): boolean {
  if (phase === null) return true
  if (phase === 'none') return row.phase === null
  return row.phase?.id === phase
}

/** The rows the filters keep, in the order given. A new array; the input is not touched. */
export function applyFilters(rows: readonly PostingListRow[], filters: PostingFilters, display: RecommendationDisplay = DEFAULT_DISPLAY): PostingListRow[] {
  const needle = fold(filters.search.trim())
  return rows.filter((row) => {
    if (needle !== '' && !haystack(row).includes(needle)) return false
    if (!matchesPhase(row, filters.phase)) return false
    if (filters.band !== null && bandOf(row, display) !== filters.band) return false
    if (!filters.includeSetAside && row.setAside) return false
    return true
  })
}

/** A day as `YYYY-MM-DD` from a date column or a timestamp, which JSON carries as a string. */
export function isoDay(value: string | Date | null | undefined): string {
  if (value === null || value === undefined) return ''
  return (typeof value === 'string' ? value : value.toISOString()).slice(0, 10)
}

type SortValue = string | number | null

/** The recommendation as one sortable number: the band first, the overall breaking ties within it. */
function recommendationValue(row: PostingListRow, display: RecommendationDisplay): number | null {
  const rank = bandRank(bandOf(row, display))
  return rank === null ? null : rank * 10 + (row.score?.overall ?? 0)
}

function sortValue(row: PostingListRow, key: SortKey, display: RecommendationDisplay): SortValue {
  switch (key) {
    case 'company':
      return fold(row.company.name)
    case 'role':
      return fold(row.posting.roleTitle)
    case 'phase':
      return row.phase === null ? null : row.phase.sort * 100_000 + (row.stage?.sort ?? 0)
    case 'score':
      return row.score?.overall ?? null
    case 'recommendation':
      return recommendationValue(row, display)
    case 'seen':
      return row.posting.seenAt
    case 'updated':
      return isoDay(row.posting.lastImportedAt as string | Date)
  }
}

function compareValues(a: SortValue, b: SortValue): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a).localeCompare(String(b))
}

/**
 * The rows sorted on one column. A missing value sorts last in either direction, because a
 * posting with no score is not a low-scoring one. Ties fall back to the id, newest first, so
 * the order is the same on every reload.
 */
export function sortRows(rows: readonly PostingListRow[], sort: GridSort, display: RecommendationDisplay = DEFAULT_DISPLAY): PostingListRow[] {
  return [...rows].sort((left, right) => {
    const a = sortValue(left, sort.key, display)
    const b = sortValue(right, sort.key, display)
    if (a === null && b !== null) return 1
    if (b === null && a !== null) return -1
    const decided = a === null || b === null ? 0 : compareValues(a, b)
    if (decided !== 0) return sort.desc ? -decided : decided
    return right.posting.id - left.posting.id
  })
}

/** The sort after a header click: the same column flips direction, a new one starts ascending. */
export function nextSort(current: GridSort, key: SortKey): GridSort {
  return current.key === key ? { key, desc: !current.desc } : { key, desc: false }
}

/* --- the board --- */

/** One board column: a phase, or `null` for the postings with no stage yet. */
export interface BoardColumn {
  readonly phase: PhaseRegistryRow | null
  readonly rows: readonly PostingListRow[]
}

/**
 * A column's order: the hand-placed rank first (lowest first, unranked last), then the best
 * score, then the newest id. An untouched column so reads best-first.
 */
export function orderColumn(rows: readonly PostingListRow[]): PostingListRow[] {
  return [...rows].sort((left, right) => {
    const a = left.posting.priorityRank ?? Number.POSITIVE_INFINITY
    const b = right.posting.priorityRank ?? Number.POSITIVE_INFINITY
    if (a !== b) return a - b
    const byScore = (right.score?.overall ?? -1) - (left.score?.overall ?? -1)
    if (byScore !== 0) return byScore
    return right.posting.id - left.posting.id
  })
}

/**
 * The board's columns in registry order (`sort`, then id). An archived phase is shown only while
 * a row still sits in it; a "no phase" column comes last, and only when a row needs it.
 */
export function boardColumns(rows: readonly PostingListRow[], phases: readonly PhaseRegistryRow[]): BoardColumn[] {
  const used = new Set(rows.flatMap((row) => (row.phase === null ? [] : [row.phase.id])))
  const known = new Map(phases.map((phase) => [phase.id, phase]))
  for (const row of rows) if (row.phase !== null && !known.has(row.phase.id)) known.set(row.phase.id, row.phase)
  const shown = [...known.values()]
    .filter((phase) => phase.archivedAt === null || used.has(phase.id))
    .sort((a, b) => a.sort - b.sort || a.id - b.id)
  const columns: BoardColumn[] = shown.map((phase) => ({ phase, rows: orderColumn(rows.filter((row) => row.phase?.id === phase.id)) }))
  const unphased = rows.filter((row) => row.phase === null)
  return unphased.length === 0 ? columns : [...columns, { phase: null, rows: orderColumn(unphased) }]
}

/**
 * The whole column's order after `id` moves one visible place. The filters can hide cards, so
 * the card swaps places with its visible neighbour in the full column and every hidden card
 * keeps its place: the order written is the column's, not the filtered view's.
 */
export function reorderColumn(fullIds: readonly number[], visibleIds: readonly number[], id: number, step: -1 | 1): number[] {
  const target = visibleIds[visibleIds.indexOf(id) + step]
  const from = fullIds.indexOf(id)
  const to = target === undefined ? -1 : fullIds.indexOf(target)
  if (visibleIds.indexOf(id) === -1 || from === -1 || to === -1) return [...fullIds]
  const next = [...fullIds]
  next[from] = target as number
  next[to] = id
  return next
}

export interface RankPatch {
  readonly id: number
  readonly priorityRank: number
}

/**
 * The writes that store a column order: ranks 1..n down the column, for every card whose stored
 * rank differs. The whole column is ranked, so a card once unranked keeps its place afterwards.
 */
export function rankPatches(rows: readonly PostingListRow[], orderedIds: readonly number[]): RankPatch[] {
  const stored = new Map(rows.map((row) => [row.posting.id, row.posting.priorityRank]))
  return orderedIds.flatMap((id, index) => (stored.get(id) === index + 1 ? [] : [{ id, priorityRank: index + 1 }]))
}

/** The rows with the patched ranks applied, as new objects, for an optimistic redraw. */
export function withRanks(rows: readonly PostingListRow[], patches: readonly RankPatch[]): PostingListRow[] {
  const ranks = new Map(patches.map((patch) => [patch.id, patch.priorityRank]))
  return rows.map((row) => {
    const rank = ranks.get(row.posting.id)
    return rank === undefined ? row : { ...row, posting: { ...row.posting, priorityRank: rank } }
  })
}

/** One page of the posting list; the server caps a page at 200 rows. */
export const PAGE_LIMIT = 200

/**
 * Every row a query matches, read page by page. The server sends no total, so a page shorter
 * than the limit is the end.
 */
export async function loadAllPages<T>(fetchPage: (offset: number, limit: number) => Promise<readonly T[]>, limit: number = PAGE_LIMIT): Promise<T[]> {
  const all: T[] = []
  for (;;) {
    const page = await fetchPage(all.length, limit)
    all.push(...page)
    if (page.length < limit) return all
  }
}

/** A ratio score on the five-star scale, one decimal; `—` when there is none. */
export function formatScore(overall: number | null | undefined): string {
  if (overall === null || overall === undefined) return '—'
  return (Math.round(overall * 50) / 10).toFixed(1)
}

