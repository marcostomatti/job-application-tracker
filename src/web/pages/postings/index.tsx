import { useCallback, useEffect, useMemo, useState } from 'react'

import { data, type CriteriaSetRow, type PhaseRegistryRow, type PostingListRow } from '../../data.ts'
import { PostingsBoard } from './board.tsx'
import { PostingDetail } from './detail.tsx'
import {
  applyFilters,
  decodeUrlState,
  encodeUrlState,
  loadAllPages,
  sortRows,
  VIEWS,
  withRanks,
  type PostingsUrlState,
  type RankPatch,
  type View,
} from './filters.ts'
import { FilterBar } from './filters.tsx'
import { PostingsGrid } from './grid.tsx'

const VIEW_LABELS: Record<View, string> = { grid: 'Grid', board: 'Board' }

const message = (failure: unknown, fallback: string): string => (failure instanceof Error ? failure.message : fallback)

/**
 * The page state kept in the query string. A change to the open posting is a new history entry,
 * so Back closes it; every other change replaces the entry, so typing a search does not fill
 * the history.
 */
function useUrlState(): [PostingsUrlState, (next: PostingsUrlState) => void] {
  const [state, setState] = useState<PostingsUrlState>(() => decodeUrlState(window.location.search))

  useEffect(() => {
    const onPop = (): void => setState(decodeUrlState(window.location.search))
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  const update = useCallback(
    (next: PostingsUrlState) => {
      const url = `${window.location.pathname}${encodeUrlState(next)}`
      if (next.posting !== state.posting) window.history.pushState(null, '', url)
      else window.history.replaceState(null, '', url)
      setState(next)
    },
    [state.posting],
  )
  return [state, update]
}

function ViewToggle({ view, onChange }: { view: View; onChange: (view: View) => void }) {
  return (
    <div className="view-toggle" role="group" aria-label="View">
      {VIEWS.map((name) => (
        <button key={name} type="button" className={`button${name === view ? ' primary' : ''}`} aria-pressed={name === view} onClick={() => onChange(name)}>
          {VIEW_LABELS[name]}
        </button>
      ))}
    </div>
  )
}

/** The postings page: the grid or the board over every loaded posting, one filter bar for both, and the open posting. */
export function PostingsPage() {
  const [state, setState] = useUrlState()
  const [rows, setRows] = useState<readonly PostingListRow[] | undefined>()
  const [phases, setPhases] = useState<readonly PhaseRegistryRow[]>([])
  const [criteriaSets, setCriteriaSets] = useState<readonly CriteriaSetRow[]>([])
  const [error, setError] = useState<string | undefined>()
  const [saving, setSaving] = useState(false)
  const { filters } = state
  const { criteriaSetId, includeSetAside } = filters

  useEffect(() => {
    data.phases().then(setPhases, (failure: unknown) => setError(message(failure, 'could not load the phases')))
    data.criteriaSets().then(setCriteriaSets, () => setCriteriaSets([]))
  }, [])

  const reload = useCallback(async () => {
    try {
      const loaded = await loadAllPages((offset, limit) =>
        data.postings({
          ...(criteriaSetId === null ? {} : { criteriaSetId }),
          setAside: includeSetAside ? 'include' : 'exclude',
          limit,
          offset,
        }),
      )
      setRows(loaded)
      setError(undefined)
    } catch (failure: unknown) {
      setError(message(failure, 'could not load the postings'))
    }
  }, [criteriaSetId, includeSetAside])

  useEffect(() => {
    void reload()
  }, [reload])

  const shown = useMemo(() => sortRows(applyFilters(rows ?? [], filters), state.sort), [rows, filters, state.sort])

  async function reorder(patches: readonly RankPatch[]): Promise<void> {
    setRows((current) => (current === undefined ? current : withRanks(current, patches)))
    setSaving(true)
    try {
      await Promise.all(patches.map((patch) => data.updatePosting(patch.id, { priorityRank: patch.priorityRank })))
    } catch (failure: unknown) {
      setError(message(failure, 'could not save the order'))
      await reload()
    } finally {
      setSaving(false)
    }
  }

  const select = (posting: number | null): void => setState({ ...state, posting })

  return (
    <div className="page wide-page postings-page">
      <header className="page-head postings-head">
        <div>
          <h1>Postings</h1>
          <p className="muted">Every posting recorded, scored against one criteria set. Bands use the default ask floor.</p>
        </div>
        <ViewToggle view={state.view} onChange={(view) => setState({ ...state, view })} />
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
      {rows !== undefined &&
        (state.view === 'grid' ? (
          <PostingsGrid rows={shown} sort={state.sort} selectedId={state.posting} onSort={(sort) => setState({ ...state, sort })} onSelect={select} />
        ) : (
          <PostingsBoard
            rows={shown}
            allRows={rows}
            phases={phases}
            selectedId={state.posting}
            saving={saving}
            onSelect={select}
            onReorder={(patches) => void reorder(patches)}
          />
        ))}
      {state.posting !== null && <PostingDetail postingId={state.posting} onClose={() => select(null)} onChanged={() => void reload()} />}
    </div>
  )
}
