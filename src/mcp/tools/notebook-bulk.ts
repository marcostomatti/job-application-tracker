import { NotebookUnavailableError } from '../../errors.ts'
import type { NotebookClient } from '../../notebook/client.ts'
import { sourcesTitled } from '../../notebook/source-titles.ts'
import { BULK_STORE_MAX, PostingStoreBulkSchema, SourceAddTextBulkSchema } from '../../schemas/notebook.ts'
import { defineTool, type ToolDefinition } from '../register.ts'
import { describeError, type ErrorDescription } from '../result.ts'
import type { NotebookToolDeps } from './notebook.ts'

const WRITES = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const

/**
 * How long a bulk store keeps starting new requests, in ms. An MCP client gives up on a tool
 * call after about 60 seconds and never sees the answer, while the server would go on storing,
 * so a retry would duplicate. A request already started may take its own 15-second timeout, so
 * 40 seconds keeps the whole call under a minute, the title lookup included.
 */
export const BULK_BUDGET_MS = 40_000

/**
 * The item a bulk store stopped at: its place in the call, why, and whether the notebook may
 * have kept it. `mayBeStored` is true when the answer was lost (a timeout, a dropped connection,
 * an answer the tracker cannot read), because the store may have gone through: check the
 * posting's sources before sending that item again. A refusal (`NotebookRequestError`) stored
 * nothing.
 */
interface BulkFailure {
  readonly index: number
  readonly mayBeStored: boolean
  readonly error: ErrorDescription
}

/**
 * What a bulk store did: the items stored, the one it stopped at, the places it never tried,
 * and whether it stopped because its time budget ran out.
 */
interface BulkOutcome<T> {
  readonly stored: T[]
  readonly failed: BulkFailure | null
  readonly notAttempted: number[]
  readonly budgetReached: boolean
}

/** The places from `start` to the end of a list of `length` items. */
const placesFrom = (start: number, length: number): number[] => Array.from({ length: Math.max(0, length - start) }, (_, k) => start + k)

/**
 * Stores the items one after another, in the order given, and stops at the first one that
 * fails. The notebook has no batch endpoint and no way to take a source back, so the call
 * cannot be all or none: what was stored stays stored, and the result says which item failed
 * and which were never sent, so a retry sends only those. One request at a time keeps the
 * notebook's own queue in order; each request returns at once, because the notebook embeds in
 * the background. No item is started after `deadline`, so the answer reaches the client.
 */
async function storeInOrder<I, T>(items: readonly I[], deadline: number, store: (item: I) => Promise<T>): Promise<BulkOutcome<T>> {
  const stored: T[] = []
  for (const [index, item] of items.entries()) {
    if (Date.now() >= deadline) return { stored, failed: null, notAttempted: placesFrom(index, items.length), budgetReached: true }
    try {
      stored.push(await store(item))
    } catch (error: unknown) {
      const failed = { index, mayBeStored: error instanceof NotebookUnavailableError, error: describeError(error) }
      return { stored, failed, notAttempted: placesFrom(index + 1, items.length), budgetReached: false }
    }
  }
  return { stored, failed: null, notAttempted: [], budgetReached: false }
}

/** One stored source as the tools answer it, without the full text the notebook echoes back. */
async function addSource(
  client: NotebookClient,
  input: { readonly title: string; readonly content: string; readonly notebookIds: string[]; readonly embed: boolean },
): Promise<unknown> {
  const { fullText: _text, ...source } = await client.addTextSource(input)
  return source
}

/**
 * The two bulk forms of the store tools. Each refuses the whole call before any request when an
 * input is wrong (an unknown posting included), and otherwise stores item by item, stopping at
 * the first the notebook refuses.
 */
export function notebookBulkTools(deps: NotebookToolDeps): ToolDefinition[] {
  const { client, postingKeyOf } = deps
  const budgetMs = deps.bulkBudgetMs ?? BULK_BUDGET_MS
  return [
    defineTool({
      name: 'notebook_posting_store_bulk',
      title: 'Store several postings\' texts in a notebook',
      description:
        `Stores the full texts of up to ${BULK_STORE_MAX} postings already in the tracker into ONE notebook in one call, each titled with its posting's postingKey, as notebook_posting_store does for one. ` +
        'Use this instead of repeated notebook_posting_store calls. Every posting is looked up first: an unknown one is a not-found error and nothing is sent. ' +
        'The texts are then stored one after another, in the order given. The notebook cannot take a source back, so this is not all or none: it stops at the first item that fails, ' +
        'keeps what was stored, and returns stored, failed (the item index, why, and mayBeStored) and notAttempted (the indexes never sent). ' +
        'It starts no new item after about 40 seconds, so the answer always arrives; budgetReached is then true and the rest are in notAttempted. ' +
        'To finish, send notAttempted again, and the failed item too: when mayBeStored is true the answer was lost and the notebook may have kept it, so check notebook_posting_sources for that posting first. ' +
        'Each stored item lists its earlierSources, the sources already titled with its key; nothing is deleted for you. Processing runs in the background, so search finds the texts a little later.',
      input: PostingStoreBulkSchema,
      annotations: WRITES,
      run: async (args, db) => {
        const deadline = Date.now() + budgetMs
        const keyed: Array<{ postingId: number; postingKey: string; content: string }> = []
        for (const item of args.items) keyed.push({ ...item, postingKey: await postingKeyOf(db, item.postingId) })
        const titles = new Set(keyed.map((item) => item.postingKey))
        const earlier = await sourcesTitled(client, titles, args.notebookId, Math.max(0, deadline - Date.now()))
        const outcome = await storeInOrder(keyed, deadline, async (item) => ({
          postingId: item.postingId,
          postingKey: item.postingKey,
          source: await addSource(client, { title: item.postingKey, content: item.content, notebookIds: [args.notebookId], embed: args.embed }),
          earlierSources: (earlier.byTitle.get(item.postingKey) ?? []).map((row) => ({ id: row.id, created: row.created })),
        }))
        const failed = outcome.failed === null ? null : { ...outcome.failed, postingId: keyed[outcome.failed.index]?.postingId }
        return { ...outcome, failed, earlierComplete: earlier.complete }
      },
    }),
    defineTool({
      name: 'notebook_source_add_text_bulk',
      title: 'Store several texts in a notebook',
      description:
        `Stores up to ${BULK_STORE_MAX} texts as sources in the same notebooks in one call, each with its own title, as notebook_source_add_text does for one. ` +
        'For postings tracked here, use notebook_posting_store_bulk instead, which titles each so it can be found again. ' +
        'The texts are stored one after another, in the order given; it stops at the first that fails and returns stored, failed (with mayBeStored) and notAttempted. ' +
        'It starts no new item after about 40 seconds (budgetReached). Send notAttempted again, and the failed item unless mayBeStored is true, in which case check notebook_source_list first. ' +
        'Processing runs in the background, so search finds the texts a little later.',
      input: SourceAddTextBulkSchema,
      annotations: WRITES,
      run: async (args) =>
        storeInOrder(args.items, Date.now() + budgetMs, async (item) => ({
          title: item.title,
          source: await addSource(client, { title: item.title, content: item.content, notebookIds: args.notebookIds, embed: args.embed }),
        })),
    }),
  ]
}
