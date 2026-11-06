import { useEffect, useMemo, useState } from 'react'

import { data, type CriteriaSetRow, type RequirementRow } from '../data.ts'
import {
  anchorsOf,
  bandRules,
  detourEntries,
  initialSetId,
  percent,
  setLabel,
  splitRequirements,
  thresholdText,
} from './criteria-helpers.ts'

/** What a coverage of 0, 0.5 and 1 mean for one requirement, folded away until asked for. */
function Anchors({ anchors }: { anchors: unknown }) {
  const points = anchorsOf(anchors)
  if (points.length === 0) return null
  return (
    <details className="criteria-anchors">
      <summary>What 0, 0.5 and 1 mean</summary>
      <dl>
        {points.map((entry) => (
          <div key={entry.point}>
            <dt>{entry.point}</dt>
            <dd>{entry.text}</dd>
          </div>
        ))}
      </dl>
    </details>
  )
}

function SoftTable({ rows }: { rows: ReturnType<typeof splitRequirements> }) {
  if (rows.soft.length === 0) return <p className="muted empty">No soft requirements in this set.</p>
  return (
    <table className="table criteria-table">
      <thead>
        <tr>
          <th>Requirement</th>
          <th>Layer</th>
          <th>Weight</th>
          <th>Share of the total</th>
        </tr>
      </thead>
      <tbody>
        {rows.soft.map(({ requirement, share }) => (
          <tr key={requirement.id}>
            <td>
              <span className="criteria-label">{requirement.label}</span>
              <Anchors anchors={requirement.anchors} />
            </td>
            <td className="muted">{requirement.layerLabel ?? '—'}</td>
            <td className="criteria-num">{requirement.weight === null ? <span className="muted">not set</span> : requirement.weight}</td>
            <td>
              {share === null ? (
                <span className="muted">not weighted</span>
              ) : (
                <span className="weight-share">
                  <span className="weight-bar" aria-hidden="true">
                    <span className="weight-fill" style={{ width: `${Math.round(share * 100)}%` }} />
                  </span>
                  <span className="criteria-num">{percent(share)}</span>
                </span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function Gates({ gates }: { gates: readonly RequirementRow[] }) {
  if (gates.length === 0) return <p className="muted">No gates in this set: nothing closes a posting outright.</p>
  return (
    <ul className="criteria-list">
      {gates.map((gate) => (
        <li key={gate.id}>
          <span className="criteria-chip gate">Gate</span> <span className="criteria-label">{gate.label}</span>
          {gate.layerLabel !== null && <span className="muted"> · {gate.layerLabel}</span>}
          <Anchors anchors={gate.anchors} />
        </li>
      ))}
    </ul>
  )
}

function Detours({ requirements }: { requirements: readonly RequirementRow[] }) {
  const entries = detourEntries(requirements)
  if (entries.length === 0) return <p className="muted">No detours recorded for this set.</p>
  return (
    <ul className="criteria-list">
      {entries.map((entry) => (
        <li key={`${entry.requirementLabel}:${entry.label}`}>
          <span className="criteria-chip detour">−{percent(entry.discount)}</span> <span className="criteria-label">{entry.label}</span>
          <span className="muted"> stands in for {entry.requirementLabel}</span>
          {entry.cost !== null && <span className="muted">, costs {entry.cost}</span>}
        </li>
      ))}
    </ul>
  )
}

/** The glossary the old settings dialog carried, in this scorer's words. */
function Glossary({ threshold }: { threshold: number | null }) {
  return (
    <section className="card criteria-glossary" aria-label="What the words mean">
      <h2>What the words mean</h2>
      <dl className="facts">
        <dt>Coverage</dt>
        <dd>How far a posting meets one requirement, from 0 (not at all) to 1 (fully). Unrated stays unrated: it is never counted as 0.</dd>
        <dt>Weight</dt>
        <dd>How much a soft requirement counts. The overall is the weighted average of the rated soft requirements, divided by the weight total.</dd>
        <dt>Gate</dt>
        <dd>A pass-or-block requirement. A closed gate skips the posting whatever it scored, and a gate adds no points.</dd>
        <dt>Detour</dt>
        <dd>A way round a requirement. Its coverage counts after its discount, so a detour can lift a requirement but never to full strength.</dd>
        <dt>Penalty</dt>
        <dd>A signed adjustment recorded on one score, of a kind from the penalty registry. It moves the overall up or down; it is not part of the set.</dd>
        <dt>Apply threshold</dt>
        <dd>The overall a posting needs, with every gate open, to be recommended. This set: {thresholdText(threshold)}.</dd>
      </dl>
      <h3>Bands</h3>
      <ul className="criteria-bands">
        {bandRules(threshold).map((rule) => (
          <li key={rule.band}>
            <span className="dot" style={{ background: `var(--band-${rule.band})` }} aria-hidden="true" />
            <strong>{rule.label}</strong> <span className="muted">{rule.rule}</span>
          </li>
        ))}
      </ul>
      <p className="muted criteria-footnote">The ask floor shown is the default; a configured floor moves the ask and skip edges.</p>
    </section>
  )
}

export interface CriteriaViewProps {
  readonly sets: readonly CriteriaSetRow[]
  readonly selectedId: number | undefined
  readonly onSelect: (id: number) => void
  /** The selected set's requirements; undefined while they load. */
  readonly requirements: readonly RequirementRow[] | undefined
}

/** The set picker, its requirements and the glossary. Pure over its props, so a test can render it with no server. */
export function CriteriaView({ sets, selectedId, onSelect, requirements }: CriteriaViewProps) {
  const selected = sets.find((set) => set.id === selectedId)
  const split = useMemo(() => splitRequirements(requirements ?? []), [requirements])

  if (sets.length === 0) return <p className="muted empty">No criteria sets yet. Load a pack with seed:pack.</p>

  return (
    <>
      <div className="card controls criteria-controls">
        <label className="field">
          <span>Criteria set</span>
          <select value={selectedId ?? ''} onChange={(event) => onSelect(Number(event.target.value))}>
            {sets.map((set) => (
              <option key={set.id} value={set.id}>
                {setLabel(set)}
              </option>
            ))}
          </select>
        </label>
        {selected !== undefined && (
          <dl className="criteria-summary">
            <div>
              <dt>Version</dt>
              <dd>v{selected.version}</dd>
            </div>
            <div>
              <dt>Apply threshold</dt>
              <dd>{thresholdText(selected.applyThreshold)}</dd>
            </div>
          </dl>
        )}
      </div>

      {requirements === undefined ? (
        <p className="muted">Loading the requirements…</p>
      ) : (
        <div className="criteria-grid">
          <section className="card criteria-wide" aria-label="Soft requirements">
            <h2>Soft requirements</h2>
            <p className="muted">Each is rated for coverage and counts by its weight. The bar is its share of the weight total.</p>
            <SoftTable rows={split} />
          </section>
          <section className="card" aria-label="Gates">
            <h2>Gates</h2>
            <p className="muted">Pass or block: a closed gate skips a posting whatever it scored.</p>
            <Gates gates={split.gates} />
          </section>
          <section className="card" aria-label="Detours and penalties">
            <h2>Detours and penalties</h2>
            <p className="muted">
              A detour's discount is what is lost going round a requirement. Penalties are recorded per score, so they are listed on a posting, not here.
            </p>
            <Detours requirements={requirements} />
          </section>
        </div>
      )}

      <Glossary threshold={selected?.applyThreshold ?? null} />
    </>
  )
}

/** The criteria page: lists the sets, opens on the default, and reads the chosen set's requirements. */
export function CriteriaPage() {
  const [sets, setSets] = useState<readonly CriteriaSetRow[] | undefined>()
  const [selectedId, setSelectedId] = useState<number | undefined>()
  const [requirements, setRequirements] = useState<readonly RequirementRow[] | undefined>()
  const [error, setError] = useState<string | undefined>()

  useEffect(() => {
    data
      .criteriaSets()
      .then((rows) => {
        setSets(rows)
        setSelectedId(initialSetId(rows))
      })
      .catch((failure: unknown) => setError(failure instanceof Error ? failure.message : 'could not load the criteria sets'))
  }, [])

  useEffect(() => {
    if (selectedId === undefined) return
    let current = true
    setRequirements(undefined)
    setError(undefined)
    data
      .requirements(selectedId)
      .then((rows) => {
        if (current) setRequirements(rows)
      })
      .catch((failure: unknown) => {
        if (current) setError(failure instanceof Error ? failure.message : 'could not load the requirements')
      })
    return () => {
      current = false
    }
  }, [selectedId])

  return (
    <div className="page wide-page">
      <header className="page-head">
        <h1>Criteria</h1>
        <p className="muted">What a posting is scored on, read back from the criteria set. Nothing here is editable; agents change it through the MCP tools.</p>
      </header>
      {error !== undefined && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {sets === undefined && error === undefined && <p className="muted">Loading…</p>}
      {sets !== undefined && <CriteriaView sets={sets} selectedId={selectedId} onSelect={setSelectedId} requirements={requirements} />}
    </div>
  )
}
