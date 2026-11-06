import type { PhaseRegistryRow, PostingListRow, RecommendationDisplay } from '../../data.ts'
import { boardColumns, formatScore, orderColumn, rankPatches, reorderColumn, type BoardColumn, type RankPatch } from './filters.ts'
import { RecommendationChips } from './recommendation-chips.tsx'
import { DEFAULT_DISPLAY, recommendationView } from './recommendation.ts'

export interface PostingsBoardProps {
  /** The filtered rows: what the columns show. */
  readonly rows: readonly PostingListRow[]
  /** Every loaded row, so a move ranks the whole column and not only the cards the filters show. */
  readonly allRows: readonly PostingListRow[]
  readonly phases: readonly PhaseRegistryRow[]
  readonly selectedId: number | null
  /** True while a reorder is being written; the move buttons wait for it. */
  readonly saving: boolean
  readonly onSelect: (postingId: number) => void
  readonly onReorder: (patches: readonly RankPatch[]) => void
  /** Which recommendation a card shows; the Settings choice, read once by the page. */
  readonly display?: RecommendationDisplay
}

const columnKey = (column: BoardColumn): string => (column.phase === null ? 'none' : String(column.phase.id))

function Card({
  row,
  selected,
  first,
  last,
  saving,
  display,
  onSelect,
  onMove,
}: {
  row: PostingListRow
  selected: boolean
  first: boolean
  last: boolean
  saving: boolean
  display: RecommendationDisplay
  onSelect: () => void
  onMove: (step: -1 | 1) => void
}) {
  const view = recommendationView(row.recommendation, display)
  const band = view.primary.band
  const { posting, company, stage } = row
  return (
    <li className={`board-card band-edge-${band}${selected ? ' selected' : ''}${row.setAside ? ' set-aside' : ''}`}>
      <button type="button" className="board-card-open" onClick={onSelect} aria-pressed={selected}>
        <span className="board-card-company">{company.name}</span>
        <span className="board-card-role">{posting.roleTitle}</span>
        <span className="board-card-meta">
          <RecommendationChips view={view} suffix={formatScore(row.score?.overall)} />
          <span className="muted">{stage?.label ?? 'No stage yet'}</span>
          {row.setAside && <span className="aside-tag">set aside</span>}
        </span>
      </button>
      <span className="board-card-move">
        <button type="button" className="button ghost icon" disabled={first || saving} onClick={() => onMove(-1)} aria-label={`Move ${posting.roleTitle} up`}>
          ↑
        </button>
        <button type="button" className="button ghost icon" disabled={last || saving} onClick={() => onMove(1)} aria-label={`Move ${posting.roleTitle} down`}>
          ↓
        </button>
      </span>
    </li>
  )
}

/**
 * The postings in one column per phase, registry order. A card's arrows move it within its
 * column; the move ranks the whole column 1..n through `onReorder`.
 */
export function PostingsBoard({ rows, allRows, phases, selectedId, saving, onSelect, onReorder, display = DEFAULT_DISPLAY }: PostingsBoardProps) {
  const columns = boardColumns(rows, phases)
  if (columns.length === 0) return <p className="muted empty">No postings match these filters.</p>

  function move(column: BoardColumn, id: number, step: -1 | 1): void {
    const phaseId = column.phase?.id ?? null
    const full = orderColumn(allRows.filter((row) => (row.phase?.id ?? null) === phaseId))
    const ids = reorderColumn(full.map((row) => row.posting.id), column.rows.map((row) => row.posting.id), id, step)
    const patches = rankPatches(full, ids)
    if (patches.length > 0) onReorder(patches)
  }

  return (
    <div className="postings-board">
      {columns.map((column) => (
        <section key={columnKey(column)} className="board-column" aria-label={column.phase?.label ?? 'No phase'}>
          <header className="board-column-head">
            <h2>{column.phase?.label ?? 'No phase'}</h2>
            <span className="stat-n">{column.rows.length}</span>
          </header>
          {column.rows.length === 0 ? (
            <p className="muted board-empty">Nothing here.</p>
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
                  onSelect={() => onSelect(row.posting.id)}
                  onMove={(step) => move(column, row.posting.id, step)}
                />
              ))}
            </ol>
          )}
        </section>
      ))}
    </div>
  )
}
