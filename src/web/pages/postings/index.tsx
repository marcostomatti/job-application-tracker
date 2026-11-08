import { useMemo } from 'react'

import { PostingDetail } from './detail.tsx'
import { applyFilters, sortRows } from './filters.ts'
import { FilterBar } from './filters.tsx'
import { PostingsGrid } from './grid.tsx'
import { usePostingsData, useUrlState } from './use-postings.ts'

/**
 * The postings page: every posting in one table, skip ones included, with every filter and
 * sort. The board is its own page; this one is where the whole list is read and searched.
 */
export function PostingsPage() {
  const [state, setState] = useUrlState()
  const { filters } = state
  const { rows, phases, criteriaSets, settings, display, error, reload } = usePostingsData(filters.criteriaSetId, filters.includeSetAside)

  const shown = useMemo(() => sortRows(applyFilters(rows ?? [], filters, display), state.sort, display), [rows, filters, state.sort, display])
  const select = (posting: number | null): void => setState({ ...state, posting })

  return (
    <div className="page wide-page postings-page">
      <header className="page-head postings-head">
        <div>
          <h1>Postings</h1>
          <p className="muted">Every posting recorded, scored against one criteria set. The recommendation shown is set in Settings.</p>
        </div>
      </header>
      <FilterBar
        filters={filters}
        phases={phases}
        criteriaSets={criteriaSets}
        shown={shown.length}
        total={rows?.length ?? 0}
        onChange={(next) => setState({ ...state, filters: next })}
      />
      {error !== undefined && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {rows === undefined && error === undefined && <p className="muted">Loading…</p>}
      {rows !== undefined && (
        <PostingsGrid rows={shown} sort={state.sort} selectedId={state.posting} display={display} onSort={(sort) => setState({ ...state, sort })} onSelect={select} />
      )}
      {state.posting !== null && (
        <PostingDetail
          postingId={state.posting}
          display={display}
          {...(settings === null ? {} : { askFloor: settings.askFloor })}
          onClose={() => select(null)}
          onChanged={() => void reload()}
        />
      )}
    </div>
  )
}
