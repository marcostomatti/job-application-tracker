import { describe, expect, test } from 'bun:test'

import {
  applyFilters,
  bandOf,
  boardColumns,
  decodeUrlState,
  DEFAULT_URL_STATE,
  EMPTY_FILTERS,
  encodeUrlState,
  formatScore,
  loadAllPages,
  nextSort,
  orderColumn,
  rankPatches,
  reorderColumn,
  sortRows,
  withRanks,
} from '../../src/web/pages/postings/filters.ts'
import { PHASES, row } from './postings-fixtures.ts'

const ids = (rows: readonly { posting: { id: number } }[]): number[] => rows.map((entry) => entry.posting.id)

describe('the URL state', () => {
  test('an empty query is the default state, and the default state encodes to nothing', () => {
    expect(decodeUrlState('')).toEqual(DEFAULT_URL_STATE)
    expect(encodeUrlState(DEFAULT_URL_STATE)).toBe('')
  })

  test('every field survives a round trip', () => {
    const state = {
      view: 'board' as const,
      posting: 42,
      sort: { key: 'score' as const, desc: false },
      filters: { search: 'data eng', phase: 'none' as const, band: 'ask' as const, includeSetAside: true, criteriaSetId: 7 },
    }

    expect(decodeUrlState(encodeUrlState(state))).toEqual(state)
  })

  test('an unreadable field falls back on its own and keeps the rest', () => {
    const state = decodeUrlState('?view=kanban&posting=-3&band=maybe&sort=score:sideways&phase=2&q=ops')

    expect(state.view).toBe('grid')
    expect(state.posting).toBeNull()
    expect(state.filters.band).toBeNull()
    expect(state.sort).toEqual(DEFAULT_URL_STATE.sort)
    expect(state.filters.phase).toBe(2)
    expect(state.filters.search).toBe('ops')
  })
})

describe('bands', () => {
  test("a row's band is the server's rules band, never recomputed from the score", () => {
    // A gate-blocked score the client cannot see: the overall alone would read as ask.
    expect(bandOf(row({ id: 1, overall: 0.8, rules: 'skip' }))).toBe('skip')
    expect(bandOf(row({ id: 2, scored: false }))).toBe('unscored')
  })

  test("under agent the band is the agent's verdict, and the rules band where there is none", () => {
    const judged = row({ id: 1, rules: 'ask', agent: { band: 'apply', reason: null } })

    expect(bandOf(judged, 'agent')).toBe('apply')
    expect(bandOf(judged, 'both')).toBe('ask')
    expect(bandOf(row({ id: 2, rules: 'skip' }), 'agent')).toBe('skip')
  })

  test('scores show on the five-star scale, a missing one as a dash', () => {
    expect(formatScore(0.73)).toBe('3.7')
    expect(formatScore(null)).toBe('—')
  })
})

describe('applyFilters', () => {
  const rows = [
    row({ id: 1, company: 'Café Norte', role: 'Platform engineer', phaseId: 1 }),
    row({ id: 2, company: 'Blue Ridge Labs', role: 'Data analyst', phaseId: 2, overall: 0.3 }),
    row({ id: 3, company: 'Quiet Harbor', role: 'Platform lead', setAside: true }),
  ]

  test('the empty filters keep everything that is not set aside', () => {
    expect(ids(applyFilters(rows, EMPTY_FILTERS))).toEqual([1, 2])
    expect(ids(applyFilters(rows, { ...EMPTY_FILTERS, includeSetAside: true }))).toEqual([1, 2, 3])
  })

  test('the search folds case and accents across company and role', () => {
    expect(ids(applyFilters(rows, { ...EMPTY_FILTERS, search: 'CAFE' }))).toEqual([1])
    expect(ids(applyFilters(rows, { ...EMPTY_FILTERS, search: 'platform', includeSetAside: true }))).toEqual([1, 3])
  })

  test('the phase filter reads a phase id, or none for rows with no stage', () => {
    expect(ids(applyFilters(rows, { ...EMPTY_FILTERS, phase: 2 }))).toEqual([2])
    expect(ids(applyFilters(rows, { ...EMPTY_FILTERS, phase: 'none', includeSetAside: true }))).toEqual([3])
  })

  test('the band filter keeps one band', () => {
    expect(ids(applyFilters(rows, { ...EMPTY_FILTERS, band: 'skip' }))).toEqual([2])
  })

  test('the band filter reads the displayed band', () => {
    const judged = [row({ id: 1, rules: 'ask', agent: { band: 'skip', reason: null } }), row({ id: 2, rules: 'skip' })]

    expect(ids(applyFilters(judged, { ...EMPTY_FILTERS, band: 'skip' }, 'both'))).toEqual([2])
    expect(ids(applyFilters(judged, { ...EMPTY_FILTERS, band: 'skip' }, 'agent'))).toEqual([1, 2])
  })

  test('the input is not changed', () => {
    const copy = [...rows]
    applyFilters(rows, { ...EMPTY_FILTERS, search: 'x' })
    expect(rows).toEqual(copy)
  })
})

describe('sortRows', () => {
  const rows = [row({ id: 1, company: 'beta', overall: 0.4 }), row({ id: 2, company: 'Alpha', scored: false }), row({ id: 3, company: 'gamma', overall: 0.9 })]

  test('a text column sorts case-folded', () => {
    expect(ids(sortRows(rows, { key: 'company', desc: false }))).toEqual([2, 1, 3])
  })

  test('a missing score sorts last in either direction', () => {
    expect(ids(sortRows(rows, { key: 'score', desc: true }))).toEqual([3, 1, 2])
    expect(ids(sortRows(rows, { key: 'score', desc: false }))).toEqual([1, 3, 2])
  })

  test('the recommendation sorts apply, ask, skip, the score breaking ties, and unscored last either way', () => {
    const banded = [
      row({ id: 1, overall: 0.55, rules: 'ask' }),
      row({ id: 2, scored: false }),
      row({ id: 3, overall: 0.9, rules: 'apply' }),
      row({ id: 4, overall: 0.7, rules: 'ask' }),
      row({ id: 5, overall: 0.2, rules: 'skip' }),
    ]

    expect(ids(sortRows(banded, { key: 'recommendation', desc: true }))).toEqual([3, 4, 1, 5, 2])
    expect(ids(sortRows(banded, { key: 'recommendation', desc: false }))).toEqual([5, 1, 4, 3, 2])
  })

  test("an old link's apply sort opens as the recommendation sort", () => {
    expect(decodeUrlState('?sort=apply:desc').sort).toEqual({ key: 'recommendation', desc: true })
  })

  test('a header click flips the same column and starts a new one ascending', () => {
    expect(nextSort({ key: 'score', desc: false }, 'score')).toEqual({ key: 'score', desc: true })
    expect(nextSort({ key: 'score', desc: true }, 'role')).toEqual({ key: 'role', desc: false })
  })
})

describe('the board order', () => {
  test('columns follow the registry sort, hide an empty archived phase, and put no phase last', () => {
    const columns = boardColumns([row({ id: 1, phaseId: 2 }), row({ id: 2, phaseId: null })], PHASES)

    expect(columns.map((column) => column.phase?.label ?? 'none')).toEqual(['Shortlist', 'Applied', 'none'])
  })

  test('an archived phase still holding a row is shown', () => {
    const columns = boardColumns([row({ id: 1, phaseId: 3 })], PHASES)

    expect(columns.map((column) => column.phase?.label)).toEqual(['Shortlist', 'Applied', 'Retired column'])
  })

  test('a column reads ranked first, then best score, then newest', () => {
    const column = [row({ id: 1, overall: 0.9 }), row({ id: 2, rank: 2 }), row({ id: 3, rank: 1 }), row({ id: 4, overall: 0.2 }), row({ id: 5, overall: 0.2 })]

    expect(ids(orderColumn(column))).toEqual([3, 2, 1, 5, 4])
  })

  test('a move swaps with the visible neighbour and leaves hidden cards in place', () => {
    expect(reorderColumn([1, 2, 3, 4], [1, 3, 4], 3, -1)).toEqual([3, 2, 1, 4])
    expect(reorderColumn([1, 2, 3], [1, 2, 3], 3, 1)).toEqual([1, 2, 3])
    expect(reorderColumn([1, 2, 3], [1, 2, 3], 9, 1)).toEqual([1, 2, 3])
  })

  test('the patches rank the whole column 1..n and skip a card already at its rank', () => {
    const column = [row({ id: 1, rank: 1 }), row({ id: 2 }), row({ id: 3, rank: 5 })]

    expect(rankPatches(column, [1, 3, 2])).toEqual([
      { id: 3, priorityRank: 2 },
      { id: 2, priorityRank: 3 },
    ])
  })

  test('withRanks returns new rows and leaves the input as it was', () => {
    const column = [row({ id: 1 }), row({ id: 2 })]
    const next = withRanks(column, [{ id: 2, priorityRank: 1 }])

    expect(next[1]?.posting.priorityRank).toBe(1)
    expect(column[1]?.posting.priorityRank).toBeNull()
    expect(next[0]).toBe(column[0])
  })
})

describe('loadAllPages', () => {
  test('reads page after page until a short one', async () => {
    const all = Array.from({ length: 5 }, (_, index) => index)
    const offsets: number[] = []
    const loaded = await loadAllPages(async (offset, limit) => {
      offsets.push(offset)
      return all.slice(offset, offset + limit)
    }, 2)

    expect(loaded).toEqual(all)
    expect(offsets).toEqual([0, 2, 4])
  })

  test('an exact multiple of the limit ends on an empty page', async () => {
    const loaded = await loadAllPages(async (offset) => (offset < 4 ? [offset, offset + 1] : []), 2)

    expect(loaded).toEqual([0, 1, 2, 3])
  })
})
