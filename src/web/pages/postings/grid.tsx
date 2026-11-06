import type { KeyboardEvent } from 'react'

import type { PostingListRow } from '../../data.ts'
import { BAND_LABELS, bandOf, formatScore, isoDay, nextSort, type GridSort, type SortKey } from './filters.ts'

export interface PostingsGridProps {
  /** Already filtered and sorted. */
  readonly rows: readonly PostingListRow[]
  readonly sort: GridSort
  readonly selectedId: number | null
  readonly onSort: (next: GridSort) => void
  readonly onSelect: (postingId: number) => void
}

const COLUMNS: readonly { key: SortKey; label: string; className?: string }[] = [
  { key: 'company', label: 'Company' },
  { key: 'role', label: 'Role' },
  { key: 'phase', label: 'Phase / stage' },
  { key: 'score', label: 'Score', className: 'num' },
  { key: 'apply', label: 'Apply' },
  { key: 'seen', label: 'Posted', className: 'date' },
  { key: 'updated', label: 'Updated', className: 'date' },
]

function SortHeader({ column, sort, onSort }: { column: (typeof COLUMNS)[number]; sort: GridSort; onSort: (next: GridSort) => void }) {
  const active = sort.key === column.key
  const direction = active ? (sort.desc ? 'descending' : 'ascending') : 'none'
  return (
    <th aria-sort={direction} className={column.className}>
      <button type="button" className="sort-button" onClick={() => onSort(nextSort(sort, column.key))}>
        {column.label}
        <span className="sort-mark" aria-hidden="true">
          {active ? (sort.desc ? '↓' : '↑') : ''}
        </span>
      </button>
    </th>
  )
}

function Row({ row, selected, onSelect }: { row: PostingListRow; selected: boolean; onSelect: (postingId: number) => void }) {
  const band = bandOf(row)
  const { posting, company, stage, phase, score } = row
  const select = (): void => onSelect(posting.id)
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      select()
    }
  }
  return (
    <tr className={`posting-row${selected ? ' selected' : ''}${row.setAside ? ' set-aside' : ''}`} tabIndex={0} onClick={select} onKeyDown={onKey} aria-selected={selected}>
      <td data-label="Company">
        {company.name}
        {row.setAside && <span className="aside-tag">set aside</span>}
      </td>
      <td data-label="Role">{posting.roleTitle}</td>
      <td data-label="Phase / stage">
        {phase === null && stage === null ? (
          <span className="muted">No stage yet</span>
        ) : (
          <>
            {phase?.label ?? <span className="muted">No phase</span>}
            {stage !== null && <span className="muted"> · {stage.label}</span>}
          </>
        )}
      </td>
      <td data-label="Score" className="num">
        <span className={`band-chip band-${band}`} title={BAND_LABELS[band]}>
          <span className="dot" aria-hidden="true" />
          {formatScore(score?.overall)}
        </span>
      </td>
      <td data-label="Apply">{score === null ? <span className="muted">—</span> : score.recommendApply ? <strong className="apply-yes">Yes</strong> : <span className="muted">No</span>}</td>
      <td data-label="Posted" className="date">
        {posting.seenAt}
      </td>
      <td data-label="Updated" className="date">
        {isoDay(posting.lastImportedAt as string | Date)}
      </td>
    </tr>
  )
}

/** The postings as a table, one column sort at a time; a click or Enter on a row opens it. */
export function PostingsGrid({ rows, sort, selectedId, onSort, onSelect }: PostingsGridProps) {
  if (rows.length === 0) return <p className="muted empty">No postings match these filters.</p>
  return (
    <div className="card postings-grid-card">
      <table className="table postings-grid">
        <thead>
          <tr>
            {COLUMNS.map((column) => (
              <SortHeader key={column.key} column={column} sort={sort} onSort={onSort} />
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <Row key={row.posting.id} row={row} selected={row.posting.id === selectedId} onSelect={onSelect} />
          ))}
        </tbody>
      </table>
    </div>
  )
}
