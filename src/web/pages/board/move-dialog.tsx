import { useEffect, useId, useRef } from 'react'

import type { PhaseRegistryRow, PostingListRow, StageRegistryRow } from '../../data.ts'
import { StageForm, type StageEventDraft } from '../postings/detail-stages.tsx'
import { stagesForPhase } from './logic.ts'

export interface MoveDialogProps {
  readonly row: PostingListRow
  /** The column the card was dropped on. */
  readonly phase: PhaseRegistryRow
  /** The whole stage registry; the dialog offers only the target phase's stages. */
  readonly stages: readonly StageRegistryRow[]
  readonly onCancel: () => void
  /** Records the stage event; a throw keeps the dialog open so the move can be sent again. */
  readonly onRecord: (draft: StageEventDraft) => Promise<void>
}

/**
 * What a drop into another column asks for: the stage in that phase, its date and a note. A
 * phase is reached through a stage, so the move is written only when the stage is chosen;
 * Cancel, Escape or a click outside leaves the card where it was.
 */
export function MoveDialog({ row, phase, stages, onCancel, onRecord }: MoveDialogProps) {
  const titleId = useId()
  const panel = useRef<HTMLDivElement>(null)
  // Read through a ref so a parent redraw neither re-binds the key nor pulls focus back to the panel.
  const cancel = useRef(onCancel)
  cancel.current = onCancel

  useEffect(() => {
    panel.current?.focus()
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') cancel.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="move-backdrop" onClick={(event) => event.target === event.currentTarget && onCancel()}>
      <div ref={panel} className="move-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <h2 id={titleId}>
          Move <strong>{row.posting.roleTitle}</strong> at {row.company.name} to {phase.label}
        </h2>
        <p className="muted">Pick the stage it reached. The date is today unless you set one.</p>
        <StageForm stages={stagesForPhase(stages, phase.id)} onRecord={onRecord} />
        <div className="move-actions">
          <button type="button" className="button ghost" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
