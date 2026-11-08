import { describe, expect, test } from 'bun:test'

import {
  boardRows,
  columnDropId,
  dragIntent,
  dropLine,
  isFadedPhase,
  placeAt,
  placeInColumn,
  slotId,
  stagesForPhase,
} from '../../src/web/pages/board/logic.ts'
import { EMPTY_FILTERS } from '../../src/web/pages/postings/filters.ts'
import { PHASES, recommendation, row, stageIn } from './postings-fixtures.ts'

// Phase 1 holds 1, 2 and 3; phase 2 holds 4; posting 5 has no phase yet.
const ROWS = [
  row({ id: 1, phaseId: 1 }),
  row({ id: 2, phaseId: 1 }),
  row({ id: 3, phaseId: 1 }),
  row({ id: 4, phaseId: 2 }),
  row({ id: 5, phaseId: null }),
]

describe('dragIntent', () => {
  test('over a card in its own column, the drag is a reorder onto that card', () => {
    expect(dragIntent(1, slotId(3), ROWS)).toEqual({ kind: 'reorder', targetId: 3 })
  })

  test('over a card in another column, the drag is a phase move to that column, not a reorder', () => {
    expect(dragIntent(1, slotId(4), ROWS)).toEqual({ kind: 'move', columnKey: '2' })
  })

  test('over another column itself, the drag is a phase move to it', () => {
    expect(dragIntent(4, columnDropId('1'), ROWS)).toEqual({ kind: 'move', columnKey: '1' })
  })

  test('over the empty part of its own column, or over nothing, the drag does nothing', () => {
    expect(dragIntent(1, columnDropId('1'), ROWS)).toEqual({ kind: 'none' })
    expect(dragIntent(1, null, ROWS)).toEqual({ kind: 'none' })
  })

  test('the no-phase column takes no drop: a stage always has a phase', () => {
    expect(dragIntent(1, columnDropId('none'), ROWS)).toEqual({ kind: 'none' })
    expect(dragIntent(1, slotId(5), ROWS)).toEqual({ kind: 'none' })
  })

  test('the mode follows the pointer: sideways is a move, back home is a reorder again', () => {
    const path = [slotId(2), slotId(4), columnDropId('2'), slotId(3)].map((over) => dragIntent(1, over, ROWS).kind)
    expect(path).toEqual(['reorder', 'move', 'move', 'reorder'])
  })
})

describe('dropLine', () => {
  const column = [1, 2, 3]

  test('dragged down, the line sits below the card it is over; dragged up, above it', () => {
    expect(dropLine({ kind: 'reorder', targetId: 3 }, column, 1, 3)).toBe('below')
    expect(dropLine({ kind: 'reorder', targetId: 1 }, column, 3, 1)).toBe('above')
  })

  test('no line on any other card, on the dragged card itself, or during a phase move', () => {
    expect(dropLine({ kind: 'reorder', targetId: 3 }, column, 1, 2)).toBeNull()
    expect(dropLine({ kind: 'reorder', targetId: 1 }, column, 1, 1)).toBeNull()
    expect(dropLine({ kind: 'move', columnKey: '2' }, column, 1, 3)).toBeNull()
  })
})

describe('placeAt', () => {
  test('dragged down, the card lands after its target; dragged up, before it', () => {
    expect(placeAt([1, 2, 3], 1, 3)).toEqual([2, 3, 1])
    expect(placeAt([1, 2, 3], 3, 1)).toEqual([3, 1, 2])
    expect(placeAt([1, 2, 3], 1, 2)).toEqual([2, 1, 3])
  })

  test('a drop on itself, a card from elsewhere, or an unknown target changes nothing', () => {
    expect(placeAt([1, 2, 3], 2, 2)).toEqual([1, 2, 3])
    expect(placeAt([1, 2, 3], 9, 2)).toEqual([1, 2, 3])
    expect(placeAt([1, 2, 3], 1, 9)).toEqual([1, 2, 3])
  })
})

describe('placeInColumn', () => {
  test('cards the filters hide keep their places; only the visible ones move', () => {
    // 20 is hidden; moving 10 below 30 reorders the visible cards around it.
    expect(placeInColumn([10, 20, 30, 40], [10, 30, 40], 10, 40)).toEqual([30, 20, 40, 10])
  })
})

describe('boardRows', () => {
  const banded = [
    row({ id: 1, phaseId: 1, rules: 'apply' }),
    row({ id: 2, phaseId: 1, rules: 'ask' }),
    row({ id: 3, phaseId: 1, rules: 'skip' }),
    row({ id: 4, phaseId: 1, scored: false }),
  ]

  test('a skip posting is left off the board by default, and shown when asked for', () => {
    expect(boardRows(banded, EMPTY_FILTERS, 'rules').map((entry) => entry.posting.id)).toEqual([1, 2, 4])
    expect(boardRows(banded, { ...EMPTY_FILTERS, showSkip: true }, 'rules').map((entry) => entry.posting.id)).toEqual([1, 2, 3, 4])
  })

  test('the band read is the display choice: an agent apply keeps a rules skip on the board', () => {
    const overruled = { ...row({ id: 9, phaseId: 1 }), recommendation: recommendation('skip', { band: 'apply', reason: null }) }
    expect(boardRows([overruled], EMPTY_FILTERS, 'rules')).toEqual([])
    expect(boardRows([overruled], EMPTY_FILTERS, 'agent').map((entry) => entry.posting.id)).toEqual([9])
  })
})

describe('isFadedPhase', () => {
  test('only the resolved phase fades', () => {
    expect(isFadedPhase({ ...PHASES[0]!, key: 'resolved' })).toBe(true)
    expect(isFadedPhase(PHASES[0]!)).toBe(false)
    expect(isFadedPhase(null)).toBe(false)
  })
})

describe('stagesForPhase', () => {
  test("a move offers the target phase's active stages, in registry order", () => {
    const archived = { ...stageIn(2, 7, 'Old step'), archivedAt: new Date('2026-01-01T00:00:00Z') }
    const stages = [stageIn(2, 6, 'Second'), stageIn(1, 3, 'Elsewhere'), stageIn(2, 4, 'First'), archived]
    expect(stagesForPhase(stages, 2).map((stage) => stage.label)).toEqual(['First', 'Second'])
  })
})
