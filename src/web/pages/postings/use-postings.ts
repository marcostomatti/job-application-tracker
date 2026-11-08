import { useCallback, useEffect, useState } from 'react'

import { data, type AppSettings, type CriteriaSetRow, type PhaseRegistryRow, type PostingListRow, type RecommendationDisplay } from '../../data.ts'
import { decodeUrlState, encodeUrlState, loadAllPages, type PostingsUrlState } from './filters.ts'
import { DEFAULT_DISPLAY } from './recommendation.ts'

export const message = (failure: unknown, fallback: string): string => (failure instanceof Error ? failure.message : fallback)

/**
 * The page state kept in the query string. A change to the open posting is a new history entry,
 * so Back closes it; every other change replaces the entry, so typing a search does not fill
 * the history.
 */
export function useUrlState(): [PostingsUrlState, (next: PostingsUrlState) => void] {
  const [state, setState] = useState<PostingsUrlState>(() => decodeUrlState(window.location.search))

  useEffect(() => {
    const onPop = (): void => setState(decodeUrlState(window.location.search))
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  const update = useCallback(
    (next: PostingsUrlState) => {
      const url = `${window.location.pathname}${encodeUrlState(next)}`
      if (next.posting !== state.posting) window.history.pushState(null, '', url)
      else window.history.replaceState(null, '', url)
      setState(next)
    },
    [state.posting],
  )
  return [state, update]
}

export interface PostingsData {
  /** Every loaded posting; undefined until the first load lands. */
  readonly rows: readonly PostingListRow[] | undefined
  readonly setRows: (update: (current: readonly PostingListRow[] | undefined) => readonly PostingListRow[] | undefined) => void
  readonly phases: readonly PhaseRegistryRow[]
  readonly criteriaSets: readonly CriteriaSetRow[]
  /** Read once on load; null until it lands or when it cannot be read. */
  readonly settings: AppSettings | null
  readonly display: RecommendationDisplay
  readonly error: string | undefined
  readonly setError: (error: string | undefined) => void
  readonly reload: () => Promise<void>
}

/**
 * What the board and the postings table both read: every posting under one criteria set, the
 * phases, the criteria sets and the settings. Until the settings land, or if they cannot be
 * read, the default display and the server's ask floor apply.
 */
export function usePostingsData(criteriaSetId: number | null, includeSetAside: boolean): PostingsData {
  const [rows, setRows] = useState<readonly PostingListRow[] | undefined>()
  const [phases, setPhases] = useState<readonly PhaseRegistryRow[]>([])
  const [criteriaSets, setCriteriaSets] = useState<readonly CriteriaSetRow[]>([])
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [error, setError] = useState<string | undefined>()

  useEffect(() => {
    data.phases().then(setPhases, (failure: unknown) => setError(message(failure, 'could not load the phases')))
    data.criteriaSets().then(setCriteriaSets, () => setCriteriaSets([]))
    data.settings().then(setSettings, () => setSettings(null))
  }, [])

  const reload = useCallback(async () => {
    try {
      const loaded = await loadAllPages((offset, limit) =>
        data.postings({
          ...(criteriaSetId === null ? {} : { criteriaSetId }),
          setAside: includeSetAside ? 'include' : 'exclude',
          limit,
          offset,
        }),
      )
      setRows(loaded)
      setError(undefined)
    } catch (failure: unknown) {
      setError(message(failure, 'could not load the postings'))
    }
  }, [criteriaSetId, includeSetAside])

  useEffect(() => {
    void reload()
  }, [reload])

  return { rows, setRows, phases, criteriaSets, settings, display: settings?.recommendationDisplay ?? DEFAULT_DISPLAY, error, setError, reload }
}
