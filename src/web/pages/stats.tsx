import { useEffect, useMemo, useState, type ReactNode } from 'react'

import type { Scale } from '../../scoring/scale.ts'
import type { MarketStats } from '../../stats/types.ts'
import { request } from '../api.ts'
import { EChart, readTokens } from '../charts/echart.tsx'
import {
  BAND_LABELS,
  BAND_ORDER,
  countBarOption,
  requirementBarOption,
  scoreScatterOption,
  sourceBarOption,
  stageRows,
  type ChartTokens,
} from '../charts/options.ts'

const SCALES: readonly Scale[] = ['stars', 'percent', 'basic', 'ratio']

/** How many stack tags and terms the page draws; the MCP read returns them all. */
const TOP_STACK = 15

interface CriteriaSetOption {
  readonly id: number
  readonly name: string
  readonly version: number
  readonly isDefault: boolean
}

export interface StatsResponse {
  readonly stats: MarketStats
  readonly reading: string
}

/** A dashboard card in the atlas format: a title, the n behind it, the chart, and what was not recorded. */
function Card({ title, n, note, children, wide = false }: { title: string; n?: string; note?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <section className={`card stat-card${wide ? ' wide' : ''}`}>
      <header className="stat-card-head">
        <h2>{title}</h2>
        {n !== undefined && <span className="stat-n">{n}</span>}
      </header>
      {children}
      {note !== undefined && <p className="stat-note">{note}</p>}
    </section>
  )
}

function Tile({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="tile">
      <span className="tile-label">
        {tone !== undefined && <span className="dot" style={{ background: `var(--band-${tone})` }} />}
        {label}
      </span>
      <span className="tile-value">{value}</span>
    </div>
  )
}

const pct = (ratio: number | null): string => (ratio === null ? '—' : `${Math.round(ratio * 100)}%`)

function Empty({ what }: { what: string }) {
  return <p className="muted empty">No {what} recorded yet.</p>
}

/** The whole dashboard for one stats read. Pure over its props, so a test can render it with no server. */
export function StatsView({ data, tokens }: { data: StatsResponse; tokens: ChartTokens }) {
  const { stats } = data
  const options = useMemo(
    () => ({
      scatter: scoreScatterOption(stats, tokens),
      sources: sourceBarOption(stats, tokens),
      stages: countBarOption(stageRows(stats), tokens),
      industries: countBarOption(stats.byIndustry.rows, tokens),
      stack: countBarOption(stats.byStack.rows.slice(0, TOP_STACK), tokens),
      requirements: requirementBarOption(stats, tokens),
    }),
    [stats, tokens],
  )
  const struggling = stats.requirements.rows.find((row) => row.key === stats.requirements.struggling)
  const easiest = stats.requirements.rows.find((row) => row.key === stats.requirements.easiest)
  const maxTerm = stats.loose.buzzwords.rows[0]?.count ?? 1
  const years = stats.loose.yearsExperience

  return (
    <div className="stats-grid">
      <div className="tiles wide">
        <Tile label="Postings" value={stats.postings} />
        {BAND_ORDER.map((band) => (
          <Tile key={band} label={BAND_LABELS[band]} value={stats.bands[band]} tone={band} />
        ))}
      </div>

      <Card
        title="Postings by score"
        n={`n=${stats.postings - stats.scoreDistribution.unscored - stats.scoreDistribution.noOverall} scored`}
        note={`${stats.scoreDistribution.unscored} unscored against this set and ${stats.scoreDistribution.noOverall} scored with no overall are not drawn.`}
        wide
      >
        <EChart option={options.scatter} ariaLabel="Count of postings at each score, coloured by lead band" />
      </Card>

      <Card title="Postings per source" n={`n=${stats.postings}`} note="Source is the route of a posting's first recorded touch.">
        {stats.bySource.length === 0 ? <Empty what="postings" /> : <EChart option={options.sources} ariaLabel="Postings per source, stacked by lead band" />}
      </Card>

      <Card title="Current stage" n={`n=${stats.postings - stats.byStage.noStage}`} note={`${stats.byStage.noStage} postings have no stage yet.`}>
        {stats.byStage.rows.length === 0 ? <Empty what="stages" /> : <EChart option={options.stages} ariaLabel="Postings per current stage, grouped by phase" />}
      </Card>

      <Card
        title="Criteria: struggling and easiest"
        n={`n=${stats.requirements.scoredPostings} scored`}
        note={
          <>
            Average effective coverage of each soft requirement; unrated is left out and counted.
            {struggling && ` Struggling most: ${struggling.label} (${pct(struggling.averageCoverage)}).`}
            {easiest && ` Easiest: ${easiest.label} (${pct(easiest.averageCoverage)}).`}
            {stats.requirements.rows.some((row) => row.tooFew) && ` Faint bars have fewer than ${stats.minN} ratings: too few to say.`}
          </>
        }
        wide
      >
        {stats.requirements.rows.length === 0 ? <Empty what="soft requirements" /> : <EChart option={options.requirements} ariaLabel="Average coverage per soft requirement" height={Math.max(160, stats.requirements.rows.length * 36)} />}
      </Card>

      <Card title="Industry" n={`n=${stats.byIndustry.recorded}`} note={`${stats.byIndustry.notRecorded} postings have no industry in their summary.`}>
        {stats.byIndustry.rows.length === 0 ? <Empty what="industries" /> : <EChart option={options.industries} ariaLabel="Postings per industry" />}
      </Card>

      <Card title="Stack" n={`n=${stats.byStack.recorded}`} note={`${stats.byStack.notRecorded} postings have no stack in their summary.`}>
        {stats.byStack.rows.length === 0 ? <Empty what="stack tags" /> : <EChart option={options.stack} ariaLabel="Postings per stack tag" height={Math.max(160, Math.min(TOP_STACK, stats.byStack.rows.length) * 26)} />}
      </Card>

      <Card title="Loose indicators" n={`n=${stats.postings}`}>
        <dl className="facts">
          <dt>Typical seniority</dt>
          <dd>
            {stats.loose.seniority.averageLabel ?? '—'} <span className="muted">(n={stats.loose.seniority.recorded}{stats.loose.seniority.tooFew ? ', too few to say' : ''})</span>
          </dd>
          <dt>Years of experience asked</dt>
          <dd>
            {years.n === 0 ? (
              <span className="muted">not recorded in any summary</span>
            ) : (
              <>
                avg {years.average}, median {years.median} <span className="muted">(n={years.n}{years.tooFew ? ', too few to say' : ''})</span>
              </>
            )}
          </dd>
        </dl>
      </Card>

      <Card title="Common terms" n={`n=${stats.loose.buzzwords.recorded} summaries`} note="Terms that at least two summaries use, sized by how many do.">
        {stats.loose.buzzwords.rows.length === 0 ? (
          <Empty what="shared terms" />
        ) : (
          <p className="cloud">
            {stats.loose.buzzwords.rows.map((row) => (
              <span key={row.label} style={{ fontSize: `${0.8 + (row.count / maxTerm) * 0.9}rem` }} title={`${row.count} summaries`}>
                {row.label}
              </span>
            ))}
          </p>
        )}
      </Card>

      <Card title="Reading for an agent" note="The same text and JSON come from the MCP tool market_stats." wide>
        <pre className="reading">{data.reading}</pre>
      </Card>
    </div>
  )
}

/** The stats page: picks the set and the scale, fetches `/api/stats`, and draws `StatsView`. */
export function StatsPage() {
  const [scale, setScale] = useState<Scale>('stars')
  const [setId, setSetId] = useState<number | undefined>()
  const [sets, setSets] = useState<readonly CriteriaSetOption[]>([])
  const [data, setData] = useState<StatsResponse | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [tokens, setTokens] = useState<ChartTokens>(() => readTokens())

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (): void => setTokens(readTokens())
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    request<CriteriaSetOption[]>('GET', '/api/criteria-sets')
      .then(setSets)
      .catch(() => setSets([]))
  }, [])

  useEffect(() => {
    const query = new URLSearchParams({ scale, ...(setId === undefined ? {} : { criteriaSetId: String(setId) }) })
    setError(undefined)
    request<StatsResponse>('GET', `/api/stats?${query}`)
      .then(setData)
      .catch((failure: unknown) => setError(failure instanceof Error ? failure.message : 'could not load the stats'))
  }, [scale, setId])

  return (
    <div className="page wide-page">
      <header className="page-head stats-head">
        <div>
          <h1>Market stats</h1>
          <p className="muted">
            Counts over the postings consumed so far, against one criteria set at a time.
            {data && ` Ask from ${data.stats.bandEdges.askFloor}, apply from ${data.stats.bandEdges.applyThreshold ?? '—'} (${scale}).`}
          </p>
        </div>
        <div className="controls">
          <label className="field">
            <span>Criteria set</span>
            <select value={setId ?? data?.stats.criteriaSet.id ?? ''} onChange={(event) => setSetId(Number(event.target.value))}>
              {sets.length === 0 && data && <option value={data.stats.criteriaSet.id}>{`${data.stats.criteriaSet.name} v${data.stats.criteriaSet.version}`}</option>}
              {sets.map((set) => (
                <option key={set.id} value={set.id}>
                  {`${set.name} v${set.version}${set.isDefault ? ' (default)' : ''}`}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Scale</span>
            <select value={scale} onChange={(event) => setScale(event.target.value as Scale)}>
              {SCALES.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        </div>
      </header>
      {error !== undefined && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {data === undefined && error === undefined && <p className="muted">Loading…</p>}
      {data !== undefined && <StatsView data={data} tokens={tokens} />}
    </div>
  )
}
