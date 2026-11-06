import { Fragment, useEffect, useMemo, useState } from 'react'

import { data, type TextAsset } from '../data.ts'
import {
  ALL_TYPES,
  filterTexts,
  formatDate,
  groupTexts,
  preview,
  typeName,
  typeNamesOf,
  typeOptions,
  type TextGroup,
  type TypeNames,
} from './texts-helpers.ts'

type CopyState = 'idle' | 'copied' | 'failed'

/** Writes to the clipboard, reporting failure: a silent no-op would leave the old clipboard to be pasted. */
function copyToClipboard(body: string, onDone: (state: CopyState) => void): void {
  const clipboard = globalThis.navigator?.clipboard
  if (clipboard === undefined) {
    onDone('failed')
    return
  }
  clipboard.writeText(body).then(
    () => onDone('copied'),
    () => onDone('failed'),
  )
}

/** The open row: one version's whole body, a copy button, and the other versions to switch to. */
function TextDetail({ group, history }: { group: TextGroup; history: boolean }) {
  const [versionId, setVersionId] = useState(group.newest.id)
  const [copy, setCopy] = useState<CopyState>('idle')
  const shown = group.versions.find((version) => version.id === versionId) ?? group.newest

  return (
    <div className="text-detail">
      <div className="text-detail-head">
        <strong>{group.label}</strong>
        <span className="muted">
          v{shown.version}, {formatDate(shown.createdAt)}
          {shown.id !== group.newest.id && ' (earlier wording)'}
        </span>
        <button
          className="button"
          type="button"
          onClick={() => {
            setCopy('idle')
            copyToClipboard(shown.body, setCopy)
          }}
        >
          Copy
        </button>
        {copy === 'copied' && (
          <span role="status" className="text-copy-ok">
            Copied to the clipboard.
          </span>
        )}
        {copy === 'failed' && (
          <span role="alert" className="error">
            Could not copy: select the text and copy it by hand.
          </span>
        )}
      </div>
      {history && group.versions.length > 1 && (
        <div className="text-versions" role="group" aria-label="Versions">
          {group.versions.map((version) => (
            <button
              key={version.id}
              type="button"
              className={`button ghost text-version${version.id === shown.id ? ' current' : ''}`}
              aria-pressed={version.id === shown.id}
              onClick={() => {
                setVersionId(version.id)
                setCopy('idle')
              }}
            >
              v{version.version}
            </button>
          ))}
        </div>
      )}
      <pre className="text-body" aria-label={`Full text: ${group.label}`}>
        {shown.body}
      </pre>
    </div>
  )
}

export interface TextsViewProps {
  readonly texts: readonly TextAsset[]
  /** Whether `texts` holds every version (the history toggle is on). */
  readonly history: boolean
  readonly onHistoryChange: (history: boolean) => void
  /** The label open at first, for a render with no clicks. */
  readonly initialOpen?: string
  /** The search at first, for a render with no typing. */
  readonly initialQuery?: string
  /** Text type labels by id; a type missing from it prints as "Type N". */
  readonly typeNames?: TypeNames
}

const COLUMNS = 5

/** The table, its search and filters. Pure over its props, so a test can render it with no server. */
export function TextsView({ texts, history, onHistoryChange, initialOpen, initialQuery = '', typeNames }: TextsViewProps) {
  const [query, setQuery] = useState(initialQuery)
  const [type, setType] = useState(ALL_TYPES)
  const [open, setOpen] = useState<string | undefined>(initialOpen)

  const groups = useMemo(() => groupTexts(texts), [texts])
  const options = useMemo(() => typeOptions(groups, typeNames), [groups, typeNames])
  const visible = useMemo(() => filterTexts(groups, { query, type }), [groups, query, type])
  const toggle = (label: string): void => setOpen(open === label ? undefined : label)

  return (
    <>
      <div className="card controls texts-controls">
        <label className="field grow">
          <span>Search</span>
          <input type="search" placeholder="Title or wording" value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <label className="field">
          <span>Type</span>
          <select value={type} onChange={(event) => setType(event.target.value)}>
            <option value={ALL_TYPES}>All types</option>
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="texts-toggle">
          <input type="checkbox" checked={history} onChange={(event) => onHistoryChange(event.target.checked)} />
          <span>Show earlier versions</span>
        </label>
      </div>

      <div className="card">
        {groups.length === 0 ? (
          <p className="muted empty">No texts yet. An agent adds them with text_add.</p>
        ) : (
          <table className="table texts-table">
            <thead>
              <tr>
                <th>Type</th>
                <th>Title</th>
                <th>Text</th>
                <th>Version</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 && (
                <tr>
                  <td colSpan={COLUMNS} className="muted empty">
                    No text matches this search.
                  </td>
                </tr>
              )}
              {visible.map((group) => {
                const isOpen = open === group.label
                return (
                  <Fragment key={group.label}>
                    <tr
                      className={`texts-row${isOpen ? ' open' : ''}`}
                      tabIndex={0}
                      aria-expanded={isOpen}
                      onClick={() => toggle(group.label)}
                      onKeyDown={(event) => {
                        if (event.key !== 'Enter' && event.key !== ' ') return
                        event.preventDefault()
                        toggle(group.label)
                      }}
                    >
                      <td>
                        <span className="text-type">{typeName(group.newest.textTypeId, typeNames)}</span>
                      </td>
                      <td className="texts-title">{group.label}</td>
                      <td className="texts-preview muted">{preview(group.newest.body)}</td>
                      <td className="texts-version">
                        v{group.newest.version}
                        {history && group.versions.length > 1 && <span className="muted"> of {group.versions.length}</span>}
                      </td>
                      <td className="texts-date">{formatDate(group.newest.createdAt)}</td>
                    </tr>
                    {isOpen && (
                      <tr className="texts-detail-row">
                        <td colSpan={COLUMNS}>
                          <TextDetail group={group} history={history} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  )
}

/** The texts page: reads `/api/texts`, with every version when the history toggle is on. */
export function TextsPage() {
  const [history, setHistory] = useState(false)
  const [texts, setTexts] = useState<readonly TextAsset[] | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [typeNames, setTypeNames] = useState<TypeNames | undefined>()

  // Read once. A failed read is not an error worth a banner: the ids still print as "Type N".
  useEffect(() => {
    data
      .textTypes()
      .then((rows) => setTypeNames(typeNamesOf(rows)))
      .catch(() => setTypeNames(new Map()))
  }, [])

  useEffect(() => {
    let current = true
    setError(undefined)
    data
      .texts({ includeHistory: history })
      .then((rows) => {
        if (current) setTexts(rows)
      })
      .catch((failure: unknown) => {
        if (current) setError(failure instanceof Error ? failure.message : 'could not load the texts')
      })
    return () => {
      current = false
    }
  }, [history])

  return (
    <div className="page wide-page">
      <header className="page-head">
        <h1>Texts</h1>
        <p className="muted">Reusable wording: cover letters, form answers, outreach. Click a row to read it whole and copy it.</p>
      </header>
      {error !== undefined && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {texts === undefined && error === undefined && <p className="muted">Loading…</p>}
      {texts !== undefined && <TextsView texts={texts} history={history} onHistoryChange={setHistory} typeNames={typeNames} />}
    </div>
  )
}
