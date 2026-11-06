import { BAND_LABELS } from '../../charts/options.ts'
import type { PostingDetail, Recommendation, RecommendationDisplay, RequirementRow, RulesBand } from '../../data.ts'
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

function BandMark({ band }: { band: RulesBand }) {
  return (
    <span className={`pd-band pd-band-${band}`}>
      <span className="dot" style={{ background: `var(--band-${band})` }} />
      {BAND_LABELS[band]}
    </span>
  )
}

/**
 * Both recommendations of the latest score, whatever the display choice: the rules band, the
 * agent's verdict with its reason, and a line when they disagree. Under `agent`, a posting the
 * agent has not judged says the grid and board show the rules band in its place.
 */
export function RecommendationSummary({ recommendation, display }: { recommendation: Recommendation | null; display: RecommendationDisplay }) {
  if (recommendation === null) return <p className="muted">No recommendation: the posting has no score yet.</p>
  const { rules, agent, disagree } = recommendation
  return (
    <div className="stack">
      <dl className="pd-rec">
        <div className="pd-rec-row">
          <dt>Rules</dt>
          <dd>
            <BandMark band={rules} />
            <span className="muted pd-small">from the score, the gates and the ask floor</span>
          </dd>
        </div>
        <div className="pd-rec-row">
          <dt>Agent</dt>
          <dd>
            {agent === null ? (
              <span className="muted">No verdict on this score.</span>
            ) : (
              <>
                <BandMark band={agent.band} />
                {agent.reason === null ? <span className="muted pd-small">no reason given</span> : <span className="pd-rec-reason">{agent.reason}</span>}
              </>
            )}
          </dd>
        </div>
      </dl>
      {disagree && agent !== null && (
        <p className="pd-rec-disagree">
          They disagree: the rules say {BAND_LABELS[rules]}, the agent says {BAND_LABELS[agent.band]}.
        </p>
      )}
      {display === 'agent' && agent === null && <p className="muted pd-small">The grid and the board show the rules band here, marked “rules”, until the agent gives a verdict.</p>}
    </div>
  )
}

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
        <BandMark band={band} />
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
