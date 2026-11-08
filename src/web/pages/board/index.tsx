import { useEffect, useMemo, useState } from 'react'

import { data, type PhaseRegistryRow, type PostingListRow, type StageRegistryRow } from '../../data.ts'
import type { StageEventDraft } from '../postings/detail-stages.tsx'
import { PostingDetail } from '../postings/detail.tsx'
import { withRanks, type RankPatch } from '../postings/filters.ts'
import { FilterBar } from '../postings/filters.tsx'
import { message, usePostingsData, useUrlState } from '../postings/use-postings.ts'
import { PostingsBoard } from './board.tsx'
import { boardRows } from './logic.ts'
import { MoveDialog } from './move-dialog.tsx'

/**
 * The board: the entry page, where what is in play is worked. One column per phase, skip
 * postings left off unless asked for (the postings table lists them all), the resolved column
 * faded until it is used. Dragging reorders a column or moves a card to another phase.
 */
export function BoardPage() {
  const [state, setState] = useUrlState()
  const { filters } = state
  const { rows, setRows, phases, criteriaSets, settings, display, error, setError, reload } = usePostingsData(filters.criteriaSetId, filters.includeSetAside)
  const [stages, setStages] = useState<readonly StageRegistryRow[]>([])
  const [saving, setSaving] = useState(false)
  const [moving, setMoving] = useState<{ row: PostingListRow; phase: PhaseRegistryRow } | null>(null)

  useEffect(() => {
    data.stages().then(setStages, (failure: unknown) => setError(message(failure, 'could not load the stages')))
  }, [setError])

  // The board has no phase or band filter: its columns are the phases, and its band rule is its own.
  const shown = useMemo(() => boardRows(rows ?? [], { ...filters, phase: null, band: null }, display), [rows, filters, display])

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

  async function record(row: PostingListRow, draft: StageEventDraft): Promise<void> {
    try {
      await data.appendStage(row.posting.id, draft)
    } catch (failure: unknown) {
      setError(message(failure, 'could not record the stage'))
      throw failure
    }
    setMoving(null)
    await reload()
  }

  const select = (posting: number | null): void => setState({ ...state, posting })

  return (
    <div className="page wide-page postings-page">
      <header className="page-head postings-head">
        <div>
          <h1>Board</h1>
          <p className="muted">What is in play, by phase. Drag a card to reorder its column, or onto another column to move it.</p>
        </div>
      </header>
      <FilterBar
        variant="board"
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
        <PostingsBoard
          rows={shown}
          allRows={rows}
          phases={phases}
          selectedId={state.posting}
          saving={saving}
          display={display}
          onSelect={select}
          onReorder={(patches) => void reorder(patches)}
          onMove={(row, phase) => setMoving({ row, phase })}
        />
      )}
      {moving !== null && (
        <MoveDialog row={moving.row} phase={moving.phase} stages={stages} onCancel={() => setMoving(null)} onRecord={(draft) => record(moving.row, draft)} />
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
