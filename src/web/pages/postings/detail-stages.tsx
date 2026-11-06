import { useState, type FormEvent } from 'react'

import type { PostingDetail, StageHistoryRow, StageRegistryRow } from '../../data.ts'
import { dateInputToInstant, formatDay, trimmedOrUndefined } from './detail-labels.ts'

type LatestStage = PostingDetail['latestStage']

export interface StageEventDraft {
  readonly stageId: number
  readonly occurredAt?: string
  readonly note?: string
}

/** The current stage and its phase, or a line saying none is recorded. */
export function CurrentStage({ latest }: { latest: LatestStage }) {
  if (latest === null) return <p className="muted">No stage recorded yet.</p>
  return (
    <p className="pd-current">
      <span className="pd-chip">{latest.stage?.label ?? 'Stage cleared'}</span>
      {latest.phase !== null && <span className="muted">{latest.phase.label}</span>}
      <span className="muted">since {formatDay(latest.event.occurredAt)}</span>
    </p>
  )
}

/**
 * The stage history, newest first, so the move that matters now sits at the top. `history` is
 * null when the history route could not be read; the current stage above still stands.
 */
export function StageTimeline({ history }: { history: readonly StageHistoryRow[] | null }) {
  if (history === null) return <p className="muted">The stage history could not be read.</p>
  if (history.length === 0) return <p className="muted">No stage events yet.</p>
  const newestFirst = [...history].reverse()
  return (
    <ol className="pd-timeline" aria-label="Stage history">
      {newestFirst.map((row) => (
        <li key={row.event.id}>
          <span className="pd-timeline-dot" aria-hidden="true" />
          <div>
            <strong>{row.stage?.label ?? 'Stage cleared'}</strong>
            <span className="muted"> · {formatDay(row.event.occurredAt)}</span>
            {row.event.note !== null && <p className="pd-note">{row.event.note}</p>}
          </div>
        </li>
      ))}
    </ol>
  )
}

/**
 * The form that appends one stage event: a stage (required), a date (empty is today, stamped by
 * the server) and a note. It only reports the draft; the panel does the write.
 */
export function StageForm({ stages, onRecord }: { stages: readonly StageRegistryRow[]; onRecord: (draft: StageEventDraft) => Promise<void> }) {
  const [stageId, setStageId] = useState('')
  const [day, setDay] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  if (stages.length === 0) return <p className="muted">The stage registry is empty, so there is no stage to record yet.</p>
  const ordered = [...stages].sort((a, b) => a.sort - b.sort || a.id - b.id)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const id = Number(stageId)
    if (!Number.isInteger(id) || id <= 0) return
    const occurredAt = dateInputToInstant(day)
    const trimmed = trimmedOrUndefined(note)
    setBusy(true)
    try {
      await onRecord({ stageId: id, ...(occurredAt === undefined ? {} : { occurredAt }), ...(trimmed === undefined ? {} : { note: trimmed }) })
      setStageId('')
      setDay('')
      setNote('')
    } catch {
      // The panel shows the failure above; the text stays so it can be sent again.
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="pd-form" onSubmit={submit} aria-label="Record a stage">
      <label className="field">
        Stage
        <select value={stageId} onChange={(event) => setStageId(event.target.value)} required>
          <option value="">Choose a stage</option>
          {ordered.map((stage) => (
            <option key={stage.id} value={stage.id}>
              {stage.label}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        Date
        <input type="date" value={day} onChange={(event) => setDay(event.target.value)} />
      </label>
      <label className="field pd-grow">
        Note
        <input type="text" value={note} onChange={(event) => setNote(event.target.value)} placeholder="Optional" />
      </label>
      <button type="submit" className="button primary" disabled={busy || stageId === ''}>
        Record
      </button>
    </form>
  )
}
