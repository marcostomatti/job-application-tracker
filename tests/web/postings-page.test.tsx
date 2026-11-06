import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import { PostingsBoard } from '../../src/web/pages/postings/board.tsx'
import { EMPTY_FILTERS } from '../../src/web/pages/postings/filters.ts'
import { FilterBar } from '../../src/web/pages/postings/filters.tsx'
import { PostingsGrid } from '../../src/web/pages/postings/grid.tsx'
import { PHASES, row } from './postings-fixtures.ts'

const noop = (): void => {}

const ROWS = [
  row({ id: 1, company: 'Northwind Example', role: 'Backend engineer', phaseId: 1, stage: 'Shortlisted', overall: 0.8, recommendApply: true }),
  row({ id: 2, company: 'Sample Works', role: 'Data analyst', phaseId: 2, stage: 'Applied', overall: 0.3 }),
  row({ id: 3, company: 'Placeholder Co', role: 'Ops lead', scored: false, setAside: true }),
]

describe('PostingsGrid', () => {
  test('draws each row with its phase, stage, band, verdict and dates, and marks the sorted column', () => {
    const html = renderToStaticMarkup(<PostingsGrid rows={ROWS} sort={{ key: 'score', desc: true }} selectedId={2} onSort={noop} onSelect={noop} />)

    for (const text of ['Northwind Example', 'Backend engineer', 'Shortlist', 'Shortlisted', '4.0', 'Yes', '2026-03-01', '2026-03-04']) {
      expect(html).toContain(text)
    }
    expect(html).toContain('band-chip band-apply')
    expect(html).toContain('band-chip band-skip')
    expect(html).toContain('band-chip band-unscored')
    expect(html).toContain('aria-sort="descending"')
    expect(html).toContain('set aside')
    expect(html.match(/posting-row selected/g)?.length).toBe(1)
  })

  test('with no rows it says so', () => {
    expect(renderToStaticMarkup(<PostingsGrid rows={[]} sort={{ key: 'seen', desc: true }} selectedId={null} onSort={noop} onSelect={noop} />)).toContain(
      'No postings match these filters.',
    )
  })
})

describe('PostingsBoard', () => {
  test('one column per phase in registry order, a no-phase column last, and move buttons disabled at the edges', () => {
    const html = renderToStaticMarkup(
      <PostingsBoard rows={ROWS} allRows={ROWS} phases={PHASES} selectedId={null} saving={false} onSelect={noop} onReorder={noop} />,
    )

    const order = ['Shortlist', 'Applied', 'No phase'].map((label) => html.indexOf(`<h2>${label}</h2>`))
    expect(order.every((at) => at >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(html).not.toContain('Retired column')
    expect(html).toContain('board-card band-edge-apply')
    expect(html).toContain('Apply 4.0')
    expect(html).toContain('No stage yet')
    // Each column here holds one card, so both of its arrows are disabled.
    expect(html.match(/disabled=""/g)?.length).toBe(ROWS.length * 2)
  })
})

describe('FilterBar', () => {
  test('lists the active phases and the criteria sets, and offers to clear only when a filter is set', () => {
    const props = { phases: PHASES, criteriaSets: [], shown: 2, total: 3, onChange: noop }
    const plain = renderToStaticMarkup(<FilterBar filters={EMPTY_FILTERS} {...props} />)
    const narrowed = renderToStaticMarkup(<FilterBar filters={{ ...EMPTY_FILTERS, band: 'ask' }} {...props} />)

    expect(plain).toContain('>Shortlist</option>')
    expect(plain).not.toContain('Retired column')
    expect(plain).toContain('2 of 3 postings')
    expect(plain).not.toContain('Clear filters')
    expect(narrowed).toContain('Clear filters')
  })
})
