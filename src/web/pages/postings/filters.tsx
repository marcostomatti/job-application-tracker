import type { LeadBand } from '../../../stats/types.ts'
import type { CriteriaSetRow, PhaseRegistryRow } from '../../data.ts'
import { BAND_LABELS, BAND_ORDER, EMPTY_FILTERS, type PhaseFilter, type PostingFilters } from './filters.ts'

export interface FilterBarProps {
  readonly filters: PostingFilters
  readonly phases: readonly PhaseRegistryRow[]
  readonly criteriaSets: readonly CriteriaSetRow[]
  /** How many rows the filters keep, and how many were loaded. */
  readonly shown: number
  readonly total: number
  readonly onChange: (next: PostingFilters) => void
}

function readPhase(value: string): PhaseFilter {
  if (value === '') return null
  if (value === 'none') return 'none'
  return Number(value)
}

const isDefault = (filters: PostingFilters): boolean =>
  filters.search === EMPTY_FILTERS.search &&
  filters.phase === EMPTY_FILTERS.phase &&
  filters.band === EMPTY_FILTERS.band &&
  filters.includeSetAside === EMPTY_FILTERS.includeSetAside &&
  filters.criteriaSetId === EMPTY_FILTERS.criteriaSetId

/** The one filter bar both views share: search, phase, band, the criteria set and set-aside postings. */
export function FilterBar({ filters, phases, criteriaSets, shown, total, onChange }: FilterBarProps) {
  const set = (patch: Partial<PostingFilters>): void => onChange({ ...filters, ...patch })
  const activePhases = phases.filter((phase) => phase.archivedAt === null)

  return (
    <div className="postings-filters" role="search">
      <label className="field postings-search">
        <span>Search</span>
        <input type="search" value={filters.search} placeholder="Company, role, place or stage" onChange={(event) => set({ search: event.target.value })} />
      </label>
      <label className="field">
        <span>Phase</span>
        <select value={filters.phase === null ? '' : String(filters.phase)} onChange={(event) => set({ phase: readPhase(event.target.value) })}>
          <option value="">All phases</option>
          {activePhases.map((phase) => (
            <option key={phase.id} value={phase.id}>
              {phase.label}
            </option>
          ))}
          <option value="none">No stage yet</option>
        </select>
      </label>
      <label className="field">
        <span>Band</span>
        <select value={filters.band ?? ''} onChange={(event) => set({ band: event.target.value === '' ? null : (event.target.value as LeadBand) })}>
          <option value="">All bands</option>
          {BAND_ORDER.map((band) => (
            <option key={band} value={band}>
              {BAND_LABELS[band]}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Criteria set</span>
        <select
          value={filters.criteriaSetId === null ? '' : String(filters.criteriaSetId)}
          onChange={(event) => set({ criteriaSetId: event.target.value === '' ? null : Number(event.target.value) })}
        >
          <option value="">Default set</option>
          {criteriaSets.map((criteriaSet) => (
            <option key={criteriaSet.id} value={criteriaSet.id}>
              {`${criteriaSet.name} v${criteriaSet.version}${criteriaSet.isDefault ? ' (default)' : ''}`}
            </option>
          ))}
        </select>
      </label>
      <label className="postings-toggle">
        <input type="checkbox" checked={filters.includeSetAside} onChange={(event) => set({ includeSetAside: event.target.checked })} />
        <span>Show set-aside</span>
      </label>
      <div className="postings-count">
        <span className="muted">
          {shown === total ? `${total} postings` : `${shown} of ${total} postings`}
        </span>
        {!isDefault(filters) && (
          <button className="button ghost" type="button" onClick={() => onChange(EMPTY_FILTERS)}>
            Clear filters
          </button>
        )}
      </div>
    </div>
  )
}
