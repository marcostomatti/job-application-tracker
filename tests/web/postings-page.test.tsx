import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import { EMPTY_FILTERS } from '../../src/web/pages/postings/filters.ts'
import { FilterBar } from '../../src/web/pages/postings/filters.tsx'
import { PostingsGrid } from '../../src/web/pages/postings/grid.tsx'
import { PHASES, row } from './postings-fixtures.ts'

const noop = (): void => {}

const ROWS = [
  row({ id: 1, company: 'Northwind Example', role: 'Backend engineer', phaseId: 1, stage: 'Shortlisted', overall: 0.8, recommendApply: true }),
  row({ id: 2, company: 'Sample Works', role: 'Data analyst', phaseId: 2, stage: 'Applied', overall: 0.3, agent: { band: 'ask', reason: 'Worth a question on scope.' } }),
  row({ id: 3, company: 'Placeholder Co', role: 'Ops lead', scored: false, setAside: true }),
]

describe('PostingsGrid', () => {
  test('draws each row with its phase, stage, score, recommendation and dates, and marks the sorted column', () => {
    const html = renderToStaticMarkup(<PostingsGrid rows={ROWS} sort={{ key: 'score', desc: true }} selectedId={2} onSort={noop} onSelect={noop} />)

    for (const text of ['Northwind Example', 'Backend engineer', 'Shortlist', 'Shortlisted', '4.0', '>Recommendation<', '2026-03-01', '2026-03-04']) {
      expect(html).toContain(text)
    }
    expect(html).toContain('band-chip band-apply')
    expect(html).toContain('band-chip band-skip')
    expect(html).toContain('band-chip band-unscored')
    expect(html).toContain('aria-sort="descending"')
    expect(html).toContain('set aside')
    expect(html.match(/posting-row selected/g)?.length).toBe(1)
    expect(html).not.toContain('>Apply</button>')
  })

  test('under both, a disagreeing row shows both chips, the flag, and the reason for a screen reader', () => {
    const html = renderToStaticMarkup(<PostingsGrid rows={ROWS} sort={{ key: 'seen', desc: true }} selectedId={null} display="both" onSort={noop} onSelect={noop} />)

    expect(html.match(/rec-disagree/g)?.length).toBe(1)
    expect(html).toContain('Rules: Skip. Agent: Ask (Worth a question on scope.). They disagree.')
  })

  test('no display draws a source tag on a chip; the source is in the tooltip only', () => {
    for (const display of ['rules', 'agent', 'both'] as const) {
      const html = renderToStaticMarkup(<PostingsGrid rows={ROWS} sort={{ key: 'seen', desc: true }} selectedId={null} display={display} onSort={noop} onSelect={noop} />)

      expect(html).not.toContain('rec-source')
      expect(html).not.toContain('>rules</span>')
      expect(html).not.toContain('>agent</span>')
    }
  })

  test('under rules, one chip per row with no source tag and no flag', () => {
    const html = renderToStaticMarkup(<PostingsGrid rows={ROWS} sort={{ key: 'seen', desc: true }} selectedId={null} display="rules" onSort={noop} onSelect={noop} />)

    expect(html.match(/rec-chip"/g)?.length).toBe(ROWS.length)
    expect(html).not.toContain('rec-source')
    expect(html).not.toContain('rec-disagree')
  })

  test('under agent, a row the agent did not judge shows the rules band marked as rules', () => {
    const html = renderToStaticMarkup(<PostingsGrid rows={ROWS} sort={{ key: 'seen', desc: true }} selectedId={null} display="agent" onSort={noop} onSelect={noop} />)

    expect(html).toContain('Agent: Ask (Worth a question on scope.)')
    expect(html).toContain('Rules: Apply. The agent gave no verdict.')
  })

  test('with no rows it says so', () => {
    expect(renderToStaticMarkup(<PostingsGrid rows={[]} sort={{ key: 'seen', desc: true }} selectedId={null} onSort={noop} onSelect={noop} />)).toContain(
      'No postings match these filters.',
    )
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
