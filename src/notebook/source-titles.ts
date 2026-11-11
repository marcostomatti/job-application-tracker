import type { NotebookClient } from './client.ts'
import type { SourceRow } from './responses.ts'
import { SOURCE_PAGE_MAX } from '../schemas/notebook.ts'

/** How many pages of sources a title lookup reads before it stops: 2,000 sources at 100 a page. */
const TITLE_LOOKUP_PAGES = 20

/** How long a title lookup may page before it stops, whatever it has read. */
const TITLE_LOOKUP_BUDGET_MS = 30_000

/** The sources found under each title asked for, and whether every page was read. */
export interface SourcesByTitle {
  readonly byTitle: ReadonlyMap<string, readonly SourceRow[]>
  readonly complete: boolean
}

/**
 * Finds the sources whose title is one of `titles`, in one notebook or in all, in one pass over
 * the source list. The notebook has no search by title, so this pages through its list and
 * matches each row here. `complete` is false when it stopped early, after 20 pages or about 30
 * seconds (or `budgetMs`, when shorter), and a copy may then be missing. A page already asked
 * for is waited on, so the lookup can overrun its budget by one request's timeout. Every title asked for has an entry, empty when none
 * was found.
 */
export async function sourcesTitled(
  client: NotebookClient,
  titles: ReadonlySet<string>,
  notebookId: string | undefined,
  budgetMs: number = TITLE_LOOKUP_BUDGET_MS,
): Promise<SourcesByTitle> {
  const found = new Map<string, SourceRow[]>([...titles].map((title) => [title, []]))
  const deadline = Date.now() + Math.min(budgetMs, TITLE_LOOKUP_BUDGET_MS)
  for (let page = 0; page < TITLE_LOOKUP_PAGES && Date.now() < deadline; page += 1) {
    const rows = await client.listSources({ notebookId, limit: SOURCE_PAGE_MAX, offset: page * SOURCE_PAGE_MAX })
    for (const row of rows) {
      if (row.title !== null && row.title !== undefined) found.get(row.title)?.push(row)
    }
    if (rows.length < SOURCE_PAGE_MAX) return { byTitle: found, complete: true }
  }
  return { byTitle: found, complete: false }
}
