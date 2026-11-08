/**
 * The board's pure rules: which postings it shows, what a drag means at each moment, where a card
 * lands, and which column fades. Pure so the drag semantics are tested without a browser: the
 * one thing a hand-placed order must never depend on is which pointer put it there.
 */
import type { PhaseRegistryRow, PostingListRow, RecommendationDisplay, StageRegistryRow } from '../../data.ts'
import { applyFilters, bandOf, type PostingFilters } from '../postings/filters.ts'

/** The column a card sits in: its phase id, or `none` before any stage is recorded. */
export type ColumnKey = string

export const NO_PHASE_COLUMN: ColumnKey = 'none'

/** The phase whose column fades: where postings go to be forgotten, still reachable. */
export const FADED_PHASE_KEY = 'resolved'

const DRAG_PREFIX = 'posting:'
const SLOT_PREFIX = 'slot:'
const COLUMN_PREFIX = 'column:'

/** The id a card is dragged by. */
export const dragId = (postingId: number): string => `${DRAG_PREFIX}${postingId}`
/** The id a card is dropped on, to place another card next to it. */
export const slotId = (postingId: number): string => `${SLOT_PREFIX}${postingId}`
/** The id a column is dropped on, to move a card into its phase. */
export const columnDropId = (key: ColumnKey): string => `${COLUMN_PREFIX}${key}`

export const isSlotId = (id: string): boolean => id.startsWith(SLOT_PREFIX)

/** The posting id inside a drag or slot id, or null for anything else. */
export function postingIdOf(id: string): number | null {
  const raw = id.startsWith(DRAG_PREFIX) ? id.slice(DRAG_PREFIX.length) : id.startsWith(SLOT_PREFIX) ? id.slice(SLOT_PREFIX.length) : null
  const value = raw === null ? Number.NaN : Number(raw)
  return Number.isInteger(value) && value > 0 ? value : null
}

export const columnKeyOf = (row: PostingListRow): ColumnKey => (row.phase === null ? NO_PHASE_COLUMN : String(row.phase.id))

/**
 * What a drag means right now. Re-read on every pointer move, so the mode follows the column
 * under the pointer: a drag that starts as a reorder becomes a phase move once it crosses into
 * another column, and a reorder again when it comes back.
 */
export type DragIntent =
  | { readonly kind: 'none' }
  | { readonly kind: 'reorder'; readonly targetId: number }
  | { readonly kind: 'move'; readonly columnKey: ColumnKey }

const NONE: DragIntent = { kind: 'none' }

export function dragIntent(activeId: number, overId: string | null, rows: readonly PostingListRow[]): DragIntent {
  const active = rows.find((row) => row.posting.id === activeId)
  if (active === undefined || overId === null) return NONE
  const home = columnKeyOf(active)

  let target: ColumnKey | null = null
  let targetId: number | null = null
  if (isSlotId(overId)) {
    targetId = postingIdOf(overId)
    const over = rows.find((row) => row.posting.id === targetId)
    if (over === undefined) return NONE
    target = columnKeyOf(over)
  } else if (overId.startsWith(COLUMN_PREFIX)) {
    target = overId.slice(COLUMN_PREFIX.length)
  }

  if (target === null) return NONE
  if (target === home) return targetId === null ? NONE : { kind: 'reorder', targetId }
  // A stage always has a phase, so nothing can be moved back to "no phase".
  if (target === NO_PHASE_COLUMN) return NONE
  return { kind: 'move', columnKey: target }
}

/** The landing line on one card: below it when the card comes down the column, above going up. */
export function dropLine(intent: DragIntent, columnIds: readonly number[], activeId: number, cardId: number): 'above' | 'below' | null {
  if (intent.kind !== 'reorder' || intent.targetId !== cardId || cardId === activeId) return null
  const from = columnIds.indexOf(activeId)
  const to = columnIds.indexOf(cardId)
  if (from === -1 || to === -1) return null
  return from < to ? 'below' : 'above'
}

/**
 * The column's ids after `dragged` is put where `target` sits. Dragged down, it lands after the
 * target; dragged up, before it — the way a sortable list behaves, and the only way the last
 * place in a column is reachable.
 */
export function placeAt(ids: readonly number[], dragged: number, target: number): number[] {
  const from = ids.indexOf(dragged)
  const to = ids.indexOf(target)
  if (dragged === target || from === -1 || to === -1) return [...ids]
  const without = ids.filter((id) => id !== dragged)
  const at = without.indexOf(target)
  const index = from < to ? at + 1 : at
  return [...without.slice(0, index), dragged, ...without.slice(index)]
}

/**
 * The whole column's order after a drop among the visible cards. Cards the filters hide keep
 * their places; the visible cards are re-dealt into the visible places in their new order.
 */
export function placeInColumn(fullIds: readonly number[], visibleIds: readonly number[], dragged: number, target: number): number[] {
  const visible = new Set(visibleIds)
  const placed = placeAt(visibleIds, dragged, target)
  let next = 0
  return fullIds.map((id) => (visible.has(id) ? (placed[next++] as number) : id))
}

/** The board's rows: the shared filters, then skip postings left off unless asked for. */
export function boardRows(rows: readonly PostingListRow[], filters: PostingFilters, display: RecommendationDisplay): PostingListRow[] {
  const filtered = applyFilters(rows, filters, display)
  return filters.showSkip ? filtered : filtered.filter((row) => bandOf(row, display) !== 'skip')
}

export const isFadedPhase = (phase: PhaseRegistryRow | null): boolean => phase?.key === FADED_PHASE_KEY

/** The stages a move into a phase offers: its active stages, in registry order. */
export function stagesForPhase(stages: readonly StageRegistryRow[], phaseId: number): StageRegistryRow[] {
  return stages.filter((stage) => stage.phaseId === phaseId && stage.archivedAt === null).sort((a, b) => a.sort - b.sort || a.id - b.id)
}
