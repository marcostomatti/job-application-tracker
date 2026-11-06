import { BAND_LABELS } from '../../charts/options.ts'
import type { PostingDetail, RequirementRow } from '../../data.ts'
import {
  breakdownRows,
  formatDay,
  formatOverall,
  formatPenalty,
  formatPercent,
  formatWeight,
  GATE_LABELS,
  scoreBand,
} from './detail-labels.ts'

type ScoreDetail = PostingDetail['scores'][number]

/**
 * The latest score: its overall and band, then one row per requirement (coverage, kind, weight,
 * gate state) and the penalties taken off it. `requirements` is null while the set's requirements
 * load or when they could not be read; the rows then show no kind and no weight.
 */
export function ScoreBreakdown({
  score,
  otherSets,
  requirements,
  askFloor,
}: {
  score: ScoreDetail | null
  otherSets: number
  requirements: readonly RequirementRow[] | null
  askFloor: number
}) {
  if (score === null) {
    return (
      <p className="pd-current">
        <span className="dot" style={{ background: 'var(--band-unscored)' }} />
        <span>{BAND_LABELS.unscored}: no score recorded yet.</span>
      </p>
    )
  }
  const rows = breakdownRows(score, requirements ?? [])
  const band = scoreBand(score, rows, askFloor)
  const { overall, scoredAt, isRescore, note } = score.score

  return (
    <div className="stack">
      <p className="pd-current">
        <span className={`pd-band pd-band-${band}`}>
          <span className="dot" style={{ background: `var(--band-${band})` }} />
          {BAND_LABELS[band]}
        </span>
        <strong>{formatOverall(overall)}</strong>
        <span className="muted">
          scored {formatDay(scoredAt)}
          {isRescore ? ' (re-score)' : ''}
          {otherSets > 0 ? ` · ${otherSets} more set${otherSets === 1 ? '' : 's'}` : ''}
        </span>
      </p>
      {note !== null && <p className="pd-note">{note}</p>}

      {rows.length === 0 ? (
        <p className="muted">No requirement was rated on this score.</p>
      ) : (
        <div className="pd-table-wrap">
          <table className="table pd-table">
            <thead>
              <tr>
                <th scope="col">Requirement</th>
                <th scope="col">Coverage</th>
                <th scope="col">Weight</th>
                <th scope="col">Gate</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.requirementId}>
                  <td>
                    {row.label}
                    {row.evidence !== null && <div className="pd-evidence muted">{row.evidence}</div>}
                  </td>
                  <td>
                    <span className="pd-bar" aria-hidden="true">
                      <span style={{ width: formatPercent(row.coverage ?? 0) }} />
                    </span>
                    {formatPercent(row.coverage)}
                  </td>
                  <td>{row.kind === 'gate' ? 'gate' : formatWeight(row.weight)}</td>
                  <td>{row.gate === null ? <span className="muted">—</span> : <span className={`pd-gate pd-gate-${row.gate}`}>{GATE_LABELS[row.gate]}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {score.penalties.length > 0 && (
        <div>
          <h4 className="pd-subhead">Penalties</h4>
          <ul className="pd-list">
            {score.penalties.map((entry) => (
              <li key={entry.penalty.id}>
                <strong>{entry.kindLabel}</strong> <span className="pd-penalty">{formatPenalty(entry.penalty.amount)}</span>
                {entry.penalty.reason !== null && <span className="muted"> · {entry.penalty.reason}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
