import {
  DndContext,
  DragOverlay,
  MouseSensor,
  pointerWithin,
  rectIntersection,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import { useState } from 'react'

import type { PhaseRegistryRow, PostingListRow, RecommendationDisplay } from '../../data.ts'
import { boardColumns, formatScore, orderColumn, rankPatches, reorderColumn, type BoardColumn, type RankPatch } from '../postings/filters.ts'
import { RecommendationChips } from '../postings/recommendation-chips.tsx'
import { DEFAULT_DISPLAY, recommendationView } from '../postings/recommendation.ts'
import {
  columnDropId,
  columnKeyOf,
  dragId,
  dragIntent,
  dropLine,
  isFadedPhase,
  isSlotId,
  NO_PHASE_COLUMN,
  placeInColumn,
  postingIdOf,
  slotId,
  type ColumnKey,
  type DragIntent,
} from './logic.ts'

export interface PostingsBoardProps {
  /** The filtered rows: what the columns show. */
  readonly rows: readonly PostingListRow[]
  /** Every loaded row, so a reorder ranks the whole column and not only the cards the filters show. */
  readonly allRows: readonly PostingListRow[]
  readonly phases: readonly PhaseRegistryRow[]
  readonly selectedId: number | null
  /** True while a reorder is being written; the move buttons wait for it. */
  readonly saving: boolean
  readonly onSelect: (postingId: number) => void
  readonly onReorder: (patches: readonly RankPatch[]) => void
  /** A card dropped on another column: the page asks for the stage before anything is written. */
  readonly onMove: (row: PostingListRow, phase: PhaseRegistryRow) => void
  /** Which recommendation a card shows; the Settings choice, read once by the page. */
  readonly display?: RecommendationDisplay
}

/**
 * What separates a drag from a click, since the whole card is the drag surface. A mouse press
 * that never travels 8px is a click and reaches the button under it. A touch waits a quarter
 * second instead: a distance rule on touch would turn every scroll of a column into a drag.
 */
export const DRAG_ACTIVATION = {
  mouse: { distance: 8 },
  touch: { delay: 250, tolerance: 8 },
} as const

/**
 * A card under the pointer wins over the column holding it, so a drag over a card reads as a
 * place in that column. With no pointer (none is tracked before the first move), the overlap
 * of the dragged card's box decides.
 */
const cardFirst: CollisionDetection = (args) => {
  const hits = pointerWithin(args)
  const card = hits.find((hit) => isSlotId(String(hit.id)))
  if (card !== undefined) return [card]
  return hits.length > 0 ? hits : rectIntersection(args)
}

const keyOfColumn = (column: BoardColumn): ColumnKey => (column.phase === null ? NO_PHASE_COLUMN : String(column.phase.id))

const DRAG_TITLE = 'Drag to reorder, or to another column to move it'

function CardBody({ row, display }: { row: PostingListRow; display: RecommendationDisplay }) {
  const view = recommendationView(row.recommendation, display)
  const { posting, company, stage } = row
  return (
    <>
      <span className="board-card-company">{company.name}</span>
      <span className="board-card-role">{posting.roleTitle}</span>
      <span className="board-card-meta">
        <RecommendationChips view={view} suffix={formatScore(row.score?.overall)} />
        <span className="muted">{stage?.label ?? 'No stage yet'}</span>
        {row.setAside && <span className="aside-tag">set aside</span>}
      </span>
    </>
  )
}

const cardClass = (row: PostingListRow, display: RecommendationDisplay): string =>
  `board-card band-edge-${recommendationView(row.recommendation, display).primary.band}${row.setAside ? ' set-aside' : ''}`

function Card({
  row,
  selected,
  first,
  last,
  saving,
  display,
  line,
  onSelect,
  onStep,
}: {
  row: PostingListRow
  selected: boolean
  first: boolean
  last: boolean
  saving: boolean
  display: RecommendationDisplay
  line: 'above' | 'below' | null
  onSelect: () => void
  onStep: (step: -1 | 1) => void
}) {
  const id = row.posting.id
  // The keyboard path is the arrows and the detail panel's stage form, so the drag surface
  // takes the pointer listeners only: its default attributes would make the card one big
  // button wrapped around the real ones.
  const draggable = useDraggable({ id: dragId(id) })
  const slot = useDroppable({ id: slotId(id) })
  const title = row.posting.roleTitle
  return (
    <li ref={slot.setNodeRef} className={`board-slot${line === null ? '' : ` drop-${line}`}`}>
      <div
        ref={draggable.setNodeRef}
        {...draggable.listeners}
        title={DRAG_TITLE}
        className={`${cardClass(row, display)} board-card-drag${selected ? ' selected' : ''}${draggable.isDragging ? ' dragging' : ''}`}
      >
        <button type="button" className="board-card-open" onClick={onSelect} aria-pressed={selected}>
          <CardBody row={row} display={display} />
        </button>
        <span className="board-card-move">
          <button type="button" className="button ghost icon" disabled={first || saving} onClick={() => onStep(-1)} aria-label={`Move ${title} up`}>
            ↑
          </button>
          <button type="button" className="button ghost icon" disabled={last || saving} onClick={() => onStep(1)} aria-label={`Move ${title} down`}>
            ↓
          </button>
        </span>
      </div>
    </li>
  )
}

function Column({
  column,
  intent,
  activeId,
  selectedId,
  saving,
  display,
  onSelect,
  onStep,
}: {
  column: BoardColumn
  intent: DragIntent
  activeId: number | null
  selectedId: number | null
  saving: boolean
  display: RecommendationDisplay
  onSelect: (postingId: number) => void
  onStep: (id: number, step: -1 | 1) => void
}) {
  const key = keyOfColumn(column)
  const droppable = useDroppable({ id: columnDropId(key), disabled: key === NO_PHASE_COLUMN })
  const target = intent.kind === 'move' && intent.columnKey === key
  const ids = column.rows.map((row) => row.posting.id)
  const label = column.phase?.label ?? 'No phase'
  const classes = ['board-column', isFadedPhase(column.phase) ? 'fading' : '', target ? 'drop-target' : ''].filter(Boolean).join(' ')

  return (
    // Stretched to the board's height: a column sized to its cards is a header when empty, and
    // a card dragged into it would pass under the only part that takes a drop.
    <section ref={droppable.setNodeRef} className={classes} aria-label={label}>
      <header className="board-column-head">
        <h2>{label}</h2>
        <span className="stat-n">{column.rows.length}</span>
      </header>
      {target && <p className="board-drop-hint">Drop to move here</p>}
      {column.rows.length === 0 ? (
        !target && <p className="muted board-empty">Nothing here.</p>
      ) : (
        <ol className="board-cards">
          {column.rows.map((row, index) => (
            <Card
              key={row.posting.id}
              row={row}
              selected={row.posting.id === selectedId}
              first={index === 0}
              last={index === column.rows.length - 1}
              saving={saving}
              display={display}
              line={activeId === null ? null : dropLine(intent, ids, activeId, row.posting.id)}
              onSelect={() => onSelect(row.posting.id)}
              onStep={(step) => onStep(row.posting.id, step)}
            />
          ))}
        </ol>
      )}
    </section>
  )
}

/**
 * The postings in one column per phase, registry order. A card dragged within its column shows
 * where it will land and is ranked there on drop; dragged over another column, that column
 * lights up and a drop asks for the stage. The arrows move a card one place without a pointer.
 */
export function PostingsBoard({ rows, allRows, phases, selectedId, saving, onSelect, onReorder, onMove, display = DEFAULT_DISPLAY }: PostingsBoardProps) {
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: DRAG_ACTIVATION.mouse }),
    useSensor(TouchSensor, { activationConstraint: DRAG_ACTIVATION.touch }),
  )
  const [drag, setDrag] = useState<{ activeId: number; overId: string | null } | null>(null)

  const columns = boardColumns(rows, phases)
  if (columns.length === 0) return <p className="muted empty">No postings match these filters.</p>

  const intent: DragIntent = drag === null ? { kind: 'none' } : dragIntent(drag.activeId, drag.overId, rows)
  const active = drag === null ? undefined : rows.find((row) => row.posting.id === drag.activeId)

  /** The whole column a row sits in, every loaded card included, in its current order. */
  const fullColumn = (key: ColumnKey): PostingListRow[] => orderColumn(allRows.filter((row) => columnKeyOf(row) === key))
  const visibleIds = (key: ColumnKey): number[] => columns.find((column) => keyOfColumn(column) === key)?.rows.map((row) => row.posting.id) ?? []

  function write(full: readonly PostingListRow[], ids: readonly number[]): void {
    const patches = rankPatches(full, ids)
    if (patches.length > 0) onReorder(patches)
  }

  function step(id: number, by: -1 | 1): void {
    const row = rows.find((entry) => entry.posting.id === id)
    if (row === undefined) return
    const key = columnKeyOf(row)
    const full = fullColumn(key)
    write(full, reorderColumn(full.map((entry) => entry.posting.id), visibleIds(key), id, by))
  }

  function end(event: DragEndEvent): void {
    setDrag(null)
    const activeId = postingIdOf(String(event.active.id))
    if (activeId === null) return
    const final = dragIntent(activeId, event.over === null ? null : String(event.over.id), rows)
    const row = rows.find((entry) => entry.posting.id === activeId)
    if (row === undefined) return

    if (final.kind === 'reorder') {
      const key = columnKeyOf(row)
      const full = fullColumn(key)
      write(full, placeInColumn(full.map((entry) => entry.posting.id), visibleIds(key), activeId, final.targetId))
    } else if (final.kind === 'move') {
      const phase = columns.find((column) => keyOfColumn(column) === final.columnKey)?.phase
      if (phase !== undefined && phase !== null) onMove(row, phase)
    }
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={cardFirst}
      onDragStart={(event: DragStartEvent) => {
        const activeId = postingIdOf(String(event.active.id))
        setDrag(activeId === null ? null : { activeId, overId: null })
      }}
      onDragOver={(event: DragOverEvent) => setDrag((current) => (current === null ? null : { ...current, overId: event.over === null ? null : String(event.over.id) }))}
      onDragCancel={() => setDrag(null)}
      onDragEnd={end}
    >
      <div className={`postings-board${drag === null ? '' : ' is-dragging'}`}>
        {columns.map((column) => (
          <Column
            key={keyOfColumn(column)}
            column={column}
            intent={intent}
            activeId={drag?.activeId ?? null}
            selectedId={selectedId}
            saving={saving}
            display={display}
            onSelect={onSelect}
            onStep={step}
          />
        ))}
      </div>
      {/* The dragged card is drawn above everything, so it can cross a column's edge. */}
      <DragOverlay dropAnimation={null}>
        {active === undefined ? null : (
          <div className={`${cardClass(active, display)} board-card-overlay${intent.kind === 'move' ? ' moving' : ''}`}>
            <span className="board-card-open">
              <CardBody row={active} display={display} />
            </span>
          </div>
        )}
      </DragOverlay>
    </DndContext>
  )
}
