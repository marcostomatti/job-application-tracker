import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import { PostingsBoard } from '../../src/web/pages/board/board.tsx'
import { MoveDialog } from '../../src/web/pages/board/move-dialog.tsx'
import { EMPTY_FILTERS } from '../../src/web/pages/postings/filters.ts'
import { FilterBar } from '../../src/web/pages/postings/filters.tsx'
import { PHASES, row, stageIn } from './postings-fixtures.ts'

const noop = (): void => {}

const RESOLVED = { id: 4, key: 'resolved', label: 'Resolved', sort: 4, isShortlist: false, archivedAt: null }
const BOARD_PHASES = [...PHASES, RESOLVED]

const ROWS = [
  row({ id: 1, company: 'Northwind Example', role: 'Backend engineer', phaseId: 1, stage: 'Shortlisted', overall: 0.8, recommendApply: true }),
  row({ id: 2, company: 'Sample Works', role: 'Data analyst', phaseId: 2, stage: 'Applied', overall: 0.3, agent: { band: 'ask', reason: 'Worth a question on scope.' } }),
  row({ id: 3, company: 'Placeholder Co', role: 'Ops lead', scored: false, setAside: true }),
]

const board = (rows = ROWS, phases = PHASES) =>
  renderToStaticMarkup(
    <PostingsBoard rows={rows} allRows={rows} phases={phases} selectedId={null} saving={false} onSelect={noop} onReorder={noop} onMove={noop} />,
  )

describe('PostingsBoard', () => {
  test('one column per phase in registry order, a no-phase column last, and move buttons disabled at the edges', () => {
    const html = board()

    const order = ['Shortlist', 'Applied', 'No phase'].map((label) => html.indexOf(`<h2>${label}</h2>`))
    expect(order.every((at) => at >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(html).not.toContain('Retired column')
    expect(html).toContain('band-edge-apply')
    expect(html).toContain('Apply 4.0')
    expect(html).toContain('rec-disagree')
    expect(html).toContain('No stage yet')
    // Each column here holds one card, so both of its arrows are disabled.
    expect(html.match(/disabled=""/g)?.length).toBe(ROWS.length * 2)
  })

  test('the whole card is the drag surface, and says so', () => {
    const html = board()

    expect(html.match(/board-card-drag/g)?.length).toBe(ROWS.length)
    expect(html).toContain('title="Drag to reorder, or to another column to move it"')
  })

  test('the resolved column fades; the others do not', () => {
    const resolvedRow = row({ id: 7, company: 'Faded Example', phaseId: 4 })
    const html = board([...ROWS, { ...resolvedRow, phase: RESOLVED }], BOARD_PHASES)

    expect(html.match(/board-column fading/g)?.length).toBe(1)
    const fadedAt = html.indexOf('board-column fading')
    expect(html.indexOf('<h2>Resolved</h2>')).toBeGreaterThan(fadedAt)
  })
})

describe('MoveDialog', () => {
  const stages = [stageIn(2, 6, 'Interview booked'), stageIn(1, 3, 'Shortlisted'), stageIn(2, 4, 'Applied')]

  test("names the card and the column, offers only that phase's stages, and can be cancelled", () => {
    const html = renderToStaticMarkup(<MoveDialog row={ROWS[0]!} phase={PHASES[0]!} stages={stages} onCancel={noop} onRecord={async () => {}} />)

    expect(html).toContain('role="dialog"')
    expect(html).toContain('Northwind Example')
    expect(html).toContain('to Applied')
    expect(html).toContain('>Applied</option>')
    expect(html).toContain('>Interview booked</option>')
    expect(html).not.toContain('>Shortlisted</option>')
    expect(html).toContain('>Cancel</button>')
  })
})

describe('FilterBar on the board', () => {
  test('the board bar has no phase or band select, and offers to show skip postings', () => {
    const html = renderToStaticMarkup(<FilterBar variant="board" filters={EMPTY_FILTERS} phases={PHASES} criteriaSets={[]} shown={2} total={3} onChange={noop} />)

    expect(html).not.toContain('All phases')
    expect(html).not.toContain('All bands')
    expect(html).toContain('Show skip')
    expect(html).toContain('Search')
  })

  test('the table bar has no skip toggle: the table shows skip postings already', () => {
    const html = renderToStaticMarkup(<FilterBar filters={EMPTY_FILTERS} phases={PHASES} criteriaSets={[]} shown={2} total={3} onChange={noop} />)

    expect(html).not.toContain('Show skip')
    expect(html).toContain('All phases')
  })
})
