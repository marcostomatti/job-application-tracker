import { useEffect, useState, type SyntheticEvent } from 'react'

import { data, type AppSettings, type AppSettingsPatch, type RecommendationDisplay } from '../data.ts'
import { RECOMMENDATION_DISPLAYS } from './postings/recommendation.ts'

/** What the page needs from the server; the real one by default, a stand-in in tests. */
export interface SettingsApi {
  settings(): Promise<AppSettings>
  updateSettings(patch: AppSettingsPatch): Promise<AppSettings>
}

export interface SettingsPageProps {
  readonly api?: SettingsApi
  /** The first read, for a render with no server. */
  readonly initial?: AppSettings
}

export const DISPLAY_OPTIONS: Readonly<Record<RecommendationDisplay, { label: string; help: string }>> = {
  rules: { label: 'Rules', help: 'Computed from the score, the gates and the ask floor.' },
  agent: { label: 'Agent', help: "The agent's verdict; the rules band is shown, marked “rules”, where the agent gave none." },
  both: { label: 'Both', help: 'Side by side, with disagreements flagged.' },
}

/** The stars scale the stats page and the postings grid read scores on: 0..5, one decimal. */
const STAR_MAX = 5

/** A stored ratio as stars, one decimal. */
export function ratioToStars(ratio: number): number {
  return Math.round(ratio * STAR_MAX * 10) / 10
}

/**
 * The ratio for a typed star value, or null when it is not a number from 0 to 5. Rounded to the
 * hundredth a one-decimal star value maps to, so 2.5 stars stores as 0.5 exactly.
 */
export function starsToRatio(raw: string): number | null {
  if (raw.trim() === '') return null
  const stars = Number(raw)
  if (!Number.isFinite(stars) || stars < 0 || stars > STAR_MAX) return null
  return Math.round((stars / STAR_MAX) * 100) / 100
}

/** Only the fields that changed; null when nothing did, so there is nothing to save. */
export function settingsPatch(saved: AppSettings, display: RecommendationDisplay, askFloor: number): AppSettingsPatch | null {
  const patch: { recommendationDisplay?: RecommendationDisplay; askFloor?: number } = {
    ...(display === saved.recommendationDisplay ? {} : { recommendationDisplay: display }),
    ...(askFloor === saved.askFloor ? {} : { askFloor }),
  }
  return Object.keys(patch).length === 0 ? null : patch
}

const messageOf = (failure: unknown, fallback: string): string => (failure instanceof Error ? failure.message : fallback)

type Status = { readonly kind: 'saved' } | { readonly kind: 'error'; readonly message: string } | null

function SettingsForm({ saved, api, onSaved }: { saved: AppSettings; api: SettingsApi; onSaved: (next: AppSettings) => void }) {
  const [display, setDisplay] = useState<RecommendationDisplay>(saved.recommendationDisplay)
  const [stars, setStars] = useState(() => String(ratioToStars(saved.askFloor)))
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status>(null)

  const askFloor = starsToRatio(stars)
  const patch = askFloor === null ? null : settingsPatch(saved, display, askFloor)

  async function save(event: SyntheticEvent): Promise<void> {
    event.preventDefault()
    if (patch === null) return
    setBusy(true)
    setStatus(null)
    try {
      const next = await api.updateSettings(patch)
      onSaved(next)
      setDisplay(next.recommendationDisplay)
      setStars(String(ratioToStars(next.askFloor)))
      setStatus({ kind: 'saved' })
    } catch (failure: unknown) {
      setStatus({ kind: 'error', message: messageOf(failure, 'could not save the settings') })
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="settings-form" onSubmit={save}>
      <fieldset className="card settings-group">
        <legend>Recommendation shown</legend>
        <p className="muted settings-lead">What the grid, the board and the band filter read. The posting detail always shows both.</p>
        {RECOMMENDATION_DISPLAYS.map((name) => (
          <label key={name} className={`settings-option${display === name ? ' checked' : ''}`}>
            <input type="radio" name="recommendationDisplay" value={name} checked={display === name} onChange={() => setDisplay(name)} />
            <span>
              <span className="settings-option-label">{DISPLAY_OPTIONS[name].label}</span>
              <span className="muted settings-option-help">{DISPLAY_OPTIONS[name].help}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <div className="card settings-group">
        <label className="field settings-floor">
          <span>Ask floor (stars)</span>
          <input
            type="number"
            inputMode="decimal"
            min={0}
            max={STAR_MAX}
            step={0.1}
            value={stars}
            aria-invalid={askFloor === null}
            aria-describedby="settings-floor-help"
            onChange={(event) => setStars(event.target.value)}
          />
        </label>
        <p id="settings-floor-help" className="muted settings-lead">
          {askFloor === null
            ? `Enter a number from 0 to ${STAR_MAX}.`
            : `A score from ${ratioToStars(askFloor)} stars (${Math.round(askFloor * 100)}%) without an apply verdict reads as Ask; below it, Skip.`}
        </p>
      </div>

      <div className="settings-actions">
        <button className="button primary" type="submit" disabled={patch === null || busy}>
          {busy ? 'Saving…' : 'Save'}
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

/** The settings page: which recommendation the postings pages show, and the ask floor. */
export function SettingsPage({ api = data, initial }: SettingsPageProps) {
  const [saved, setSaved] = useState<AppSettings | undefined>(initial)
  const [error, setError] = useState<string | undefined>()

  useEffect(() => {
    if (initial !== undefined) return
    api.settings().then(setSaved, (failure: unknown) => setError(messageOf(failure, 'could not load the settings')))
  }, [api, initial])

  return (
    <div className="page">
      <header className="page-head">
        <h1>Settings</h1>
        <p className="muted">How the postings pages read a recommendation. The postings page reads these when it opens.</p>
      </header>
      {error !== undefined && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {saved === undefined && error === undefined && <p className="muted">Loading…</p>}
      {saved !== undefined && <SettingsForm saved={saved} api={api} onSaved={setSaved} />}
    </div>
  )
}
