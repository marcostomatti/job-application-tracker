import { useState, type SyntheticEvent } from 'react'

import { linkFromKey, POSTING_LINK_PATTERNS_MAX, PostingLinkPatternsSchema, type PostingLinkPattern } from '../../schemas/posting-links.ts'
import type { AppSettings } from '../data.ts'
import type { SettingsApi } from './settings.tsx'

/** One editable row: what the user typed, kept as typed until it is saved. */
export interface PatternDraft {
  readonly prefix: string
  readonly template: string
}

/**
 * The patterns to save, or the first problem with the rows. A row left wholly blank is dropped,
 * so adding a row and not using it never blocks a save.
 */
export function patternsFromDrafts(drafts: readonly PatternDraft[]): { readonly patterns: PostingLinkPattern[] } | { readonly problem: string } {
  const filled = drafts.filter((draft) => draft.prefix.trim() !== '' || draft.template.trim() !== '')
  const parsed = PostingLinkPatternsSchema.safeParse(filled)
  if (parsed.success) return { patterns: parsed.data }
  const issue = parsed.error.issues[0]
  const row = typeof issue?.path[0] === 'number' ? `Row ${issue.path[0] + 1}: ` : ''
  return { problem: `${row}${issue?.message ?? 'these patterns cannot be saved'}` }
}

/** True when the drafts would save the very list already stored. */
export function samePatterns(drafts: readonly PostingLinkPattern[], saved: readonly PostingLinkPattern[]): boolean {
  return drafts.length === saved.length && drafts.every((draft, index) => draft.prefix === saved[index]?.prefix && draft.template === saved[index]?.template)
}

type Status = { readonly kind: 'saved' } | { readonly kind: 'error'; readonly message: string } | null

/**
 * The link patterns: how a posting key such as `board:123` becomes a link in the posting panel.
 * Saved on their own, so editing them never resends the recommendation settings.
 */
export function LinkPatternsForm({ saved, api, onSaved }: { saved: AppSettings; api: SettingsApi; onSaved: (next: AppSettings) => void }) {
  const [drafts, setDrafts] = useState<PatternDraft[]>(() => saved.postingLinkPatterns.map(({ prefix, template }) => ({ prefix, template })))
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status>(null)

  const result = patternsFromDrafts(drafts)
  const changed = 'patterns' in result && !samePatterns(result.patterns, saved.postingLinkPatterns)
  const edit = (index: number, field: keyof PatternDraft, value: string): void =>
    setDrafts(drafts.map((draft, at) => (at === index ? { ...draft, [field]: value } : draft)))

  async function save(event: SyntheticEvent): Promise<void> {
    event.preventDefault()
    if (!('patterns' in result) || !changed) return
    setBusy(true)
    setStatus(null)
    try {
      const next = await api.updateSettings({ postingLinkPatterns: result.patterns })
      onSaved(next)
      setDrafts(next.postingLinkPatterns.map(({ prefix, template }) => ({ prefix, template })))
      setStatus({ kind: 'saved' })
    } catch (failure: unknown) {
      setStatus({ kind: 'error', message: failure instanceof Error ? failure.message : 'could not save the link patterns' })
    } finally {
      setBusy(false)
    }
  }

  const example = 'patterns' in result ? result.patterns[0] : undefined
  const exampleKey = example === undefined ? undefined : `${example.prefix}:12345`

  return (
    <form className="settings-form" onSubmit={save}>
      <fieldset className="card settings-group">
        <legend>Posting links</legend>
        <p className="muted settings-lead">
          A posting key written as <code>prefix:id</code> opens the template for its prefix, with <code>{'{id}'}</code> replaced by the id. A link in the
          posting itself or its summary comes first.
        </p>
        {drafts.map((draft, index) => (
          <div key={index} className="settings-pattern">
            <label className="field">
              <span>Prefix</span>
              <input value={draft.prefix} placeholder="board" onChange={(event) => edit(index, 'prefix', event.target.value)} />
            </label>
            <label className="field settings-pattern-template">
              <span>Template</span>
              <input value={draft.template} placeholder="https://jobs.example.test/view/{id}" onChange={(event) => edit(index, 'template', event.target.value)} />
            </label>
            <button type="button" className="button ghost" aria-label={`Remove pattern ${index + 1}`} onClick={() => setDrafts(drafts.filter((_, at) => at !== index))}>
              Remove
            </button>
          </div>
        ))}
        {drafts.length < POSTING_LINK_PATTERNS_MAX && (
          <button type="button" className="button ghost settings-pattern-add" onClick={() => setDrafts([...drafts, { prefix: '', template: '' }])}>
            Add a pattern
          </button>
        )}
        {'problem' in result ? (
          <p className="error settings-lead" role="alert">
            {result.problem}
          </p>
        ) : (
          example !== undefined &&
          exampleKey !== undefined && (
            <p className="muted settings-lead">
              For example, <code>{exampleKey}</code> opens <code>{linkFromKey(exampleKey, result.patterns)}</code>.
            </p>
          )
        )}
      </fieldset>

      <div className="settings-actions">
        <button className="button primary" type="submit" disabled={!changed || busy}>
          {busy ? 'Saving…' : 'Save links'}
        </button>
        {status?.kind === 'saved' && (
          <span className="settings-saved" role="status">
            Saved.
          </span>
        )}
        {status?.kind === 'error' && (
          <span className="error" role="alert">
            {status.message}
          </span>
        )}
      </div>
    </form>
  )
}
