import type { NotebookClient } from './client.ts'
import type { SourceRow } from './responses.ts'
import { sourcesTitled } from './source-titles.ts'

/** The most text one read returns: a posting is a few thousand characters, so this cap only guards against a pasted book. */
export const POSTING_TEXT_MAX_CHARS = 200_000

/** How long the title lookup may page through the notebook, in ms, so the web panel never waits long. */
const LOOKUP_BUDGET_MS = 10_000

/** The newest notebook copy of one posting's text, as the posting panel shows it. */
export type PostingText =
  | { readonly configured: false }
  | {
      readonly configured: true
      readonly postingKey: string
      /** How many sources carry the posting key as their title; the newest is the one read. */
      readonly copies: number
      /** False when the lookup stopped early, so a newer copy may exist. */
      readonly complete: boolean
      readonly source: { readonly id: string; readonly title: string | null; readonly created: string | null } | null
      readonly text: string | null
      readonly totalChars: number
      readonly truncated: boolean
    }

/** The newest of the rows by their creation stamp. Open Notebook writes every stamp in one format, so text order is time order. */
function newest(rows: readonly SourceRow[]): SourceRow | undefined {
  return rows.reduce<SourceRow | undefined>((best, row) => (best === undefined || (row.created ?? '') > (best.created ?? '') ? row : best), undefined)
}

/**
 * Finds the sources titled with `postingKey`, the link `notebook_posting_store` writes, and reads
 * the newest one's text, cut at `maxChars`. No notebook configured is an answer, not an error,
 * because the tracker runs without one; a notebook that does not answer throws, so the panel can
 * say the text could not be read rather than that there is none.
 */
export async function postingText(client: NotebookClient | undefined, postingKey: string, maxChars = POSTING_TEXT_MAX_CHARS): Promise<PostingText> {
  if (client === undefined) return { configured: false }
  const found = await sourcesTitled(client, new Set([postingKey]), undefined, LOOKUP_BUDGET_MS)
  const rows = found.byTitle.get(postingKey) ?? []
  const latest = newest(rows)
  const base = { configured: true, postingKey, copies: rows.length, complete: found.complete } as const
  if (latest === undefined) return { ...base, source: null, text: null, totalChars: 0, truncated: false }
  const { fullText } = await client.getSource(latest.id)
  const full = fullText ?? ''
  return {
    ...base,
    source: { id: latest.id, title: latest.title ?? null, created: latest.created ?? null },
    text: full.slice(0, maxChars),
    totalChars: full.length,
    truncated: full.length > maxChars,
  }
}
