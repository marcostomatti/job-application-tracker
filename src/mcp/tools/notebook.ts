import { findPostingKey } from '../../data/repositories/posting-key.ts'
import type { Db } from '../../data/repositories/db.ts'
import type { NotebookClient } from '../../notebook/client.ts'
import type { SourceRow } from '../../notebook/responses.ts'
import { sourcesTitled } from '../../notebook/source-titles.ts'
import {
  NoteAddSchema,
  NotebookCreateSchema,
  NotebookListSchema,
  PostingSourcesSchema,
  PostingStoreSchema,
  SearchSchema,
  SourceAddTextSchema,
  SourceGetSchema,
  SourceListSchema,
  SourceRefSchema,
} from '../../schemas/notebook.ts'
import { defineTool, type ToolDefinition } from '../register.ts'
import { notebookBulkTools } from './notebook-bulk.ts'

/** What the notebook tools need: the client, and the one tracker read they make. */
export interface NotebookToolDeps {
  readonly client: NotebookClient
  readonly postingKeyOf: (db: Db, postingId: number) => Promise<string>
  /** How long a bulk store may start new requests, in ms; a test sets it, and it defaults to `BULK_BUDGET_MS`. */
  readonly bulkBudgetMs?: number
}

/** Every notebook tool name, in registration order, so a test can pin the set. */
export const NOTEBOOK_TOOL_NAMES = [
  'notebook_list',
  'notebook_create',
  'notebook_source_list',
  'notebook_source_get',
  'notebook_source_add_text',
  'notebook_source_delete',
  'notebook_posting_store',
  'notebook_posting_sources',
  'notebook_search',
  'notebook_note_add',
  'notebook_posting_store_bulk',
  'notebook_source_add_text_bulk',
] as const

const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const
const WRITES = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const

/**
 * The Open Notebook tools. They exist only when a notebook is configured and answered at
 * startup (`server.ts` decides), and they may be the only way to reach a notebook run as a
 * container with no UI, so they cover the whole loop: notebooks, sources, a posting's text,
 * search and notes. None of them writes to the tracker; the one tracker read is a posting's key.
 */
export function notebookTools(deps: NotebookToolDeps): ToolDefinition[] {
  const { client, postingKeyOf } = deps
  /** The sources titled with one posting key, from the shared lookup. */
  const sourcesOne = async (title: string, notebookId: string | undefined): Promise<{ sources: readonly SourceRow[]; complete: boolean }> => {
    const found = await sourcesTitled(client, new Set([title]), notebookId)
    return { sources: found.byTitle.get(title) ?? [], complete: found.complete }
  }
  return [
    defineTool({
      name: 'notebook_list',
      title: 'List notebooks',
      description:
        'Lists the notebooks in Open Notebook with their id, name, description and how many sources and notes each holds. ' +
        'Archived notebooks are left out unless includeArchived is true. A notebook id (notebook:…) is what the other notebook tools take.',
      input: NotebookListSchema,
      annotations: READ_ONLY,
      run: async (args) => client.listNotebooks({ archived: args.includeArchived === true ? undefined : false }),
    }),
    defineTool({
      name: 'notebook_create',
      title: 'Create a notebook',
      description:
        'Creates a notebook and returns it with its id. A useful layout is one notebook per employer you are serious about, ' +
        'named as the tracker stores the company, plus one for your own background (CV, past-work notes). ' +
        'Call notebook_list first: two notebooks may share a name, and this does not check.',
      input: NotebookCreateSchema,
      annotations: WRITES,
      run: async (args) => client.createNotebook({ name: args.name, description: args.description }),
    }),
    defineTool({
      name: 'notebook_source_list',
      title: 'List notebook sources',
      description:
        'Lists sources (stored documents), newest first, without their text: id, title, whether they are embedded for meaning search, and processing status. ' +
        'Give notebookId to list one notebook; leave it out for all. Pages of up to 100; use offset for the next page. ' +
        'Use notebook_source_get to read a source.',
      input: SourceListSchema,
      annotations: READ_ONLY,
      run: async (args) => client.listSources(args),
    }),
    defineTool({
      name: 'notebook_source_get',
      title: 'Read a notebook source',
      description:
        'Returns ONE source with its text, for example a CV or past-work notes you need before scoring or answering a question. ' +
        'The text comes in a window: maxChars from offset (default 20000 from 0). truncated is true when more follows; ' +
        'call again with offset set to textOffset plus the length you got. An unknown id is a not-found error.',
      input: SourceGetSchema,
      annotations: READ_ONLY,
      run: async (args) => {
        const { fullText, ...source } = await client.getSource(args.sourceId)
        const full = fullText ?? ''
        const text = full.slice(args.offset, args.offset + args.maxChars)
        return { ...source, text, textOffset: args.offset, totalChars: full.length, truncated: args.offset + text.length < full.length }
      },
    }),
    defineTool({
      name: 'notebook_source_add_text',
      title: 'Store text in a notebook',
      description:
        'Stores pasted text as a source in one or more notebooks, embedded for meaning search unless embed is false. ' +
        'For a posting tracked here, use notebook_posting_store instead, which titles it so it can be found again. ' +
        'Processing runs in the background: the returned status is not final, and search finds the text a little later. ' +
        'Sources are copies; to change one, store the new text and delete the old source.',
      input: SourceAddTextSchema,
      annotations: WRITES,
      run: async (args) => {
        const { fullText: _text, ...source } = await client.addTextSource(args)
        return source
      },
    }),
    defineTool({
      name: 'notebook_source_delete',
      title: 'Delete a notebook source',
      description:
        'Deletes ONE source from Open Notebook, from every notebook it is in. This cannot be undone. ' +
        'Use it to remove an older copy after storing a new one, so a search cannot answer from the version you replaced. ' +
        'Confirm with the user before deleting anything they did not ask to replace.',
      input: SourceRefSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      run: async (args) => {
        await client.deleteSource(args.sourceId)
        return { deleted: args.sourceId }
      },
    }),
    defineTool({
      name: 'notebook_posting_store',
      title: 'Store a posting\'s text in a notebook',
      description:
        'Stores the full text of ONE posting already in the tracker as a source in a notebook, titled with the posting\'s postingKey, ' +
        'which is the link between the two: no tracker row points at the notebook. An unknown posting is a not-found error and stores nothing. ' +
        'earlierSources lists sources with the same title already there; nothing is deleted for you, so after the new one has finished processing, ' +
        'delete those with notebook_source_delete if they are older copies. Nothing in the tracker is changed.',
      input: PostingStoreSchema,
      annotations: WRITES,
      run: async (args, db) => {
        const postingKey = await postingKeyOf(db, args.postingId)
        const earlier = await sourcesOne(postingKey, args.notebookId)
        const { fullText: _text, ...source } = await client.addTextSource({
          title: postingKey,
          content: args.content,
          notebookIds: [args.notebookId],
          embed: args.embed,
        })
        return {
          postingKey,
          source,
          earlierSources: earlier.sources.map((row) => ({ id: row.id, created: row.created })),
          earlierComplete: earlier.complete,
        }
      },
    }),
    defineTool({
      name: 'notebook_posting_sources',
      title: 'Find a posting\'s notebook sources',
      description:
        'Finds the sources titled with ONE posting\'s postingKey, in one notebook or in all. ' +
        'complete is false when the lookup stopped early (past 2000 sources, or after about 30 seconds) and a copy may be missing. ' +
        'An unknown posting is a not-found error.',
      input: PostingSourcesSchema,
      annotations: READ_ONLY,
      run: async (args, db) => {
        const postingKey = await postingKeyOf(db, args.postingId)
        const found = await sourcesOne(postingKey, args.notebookId)
        return { postingKey, sources: found.sources, complete: found.complete }
      },
    }),
    defineTool({
      name: 'notebook_search',
      title: 'Search the notebook',
      description:
        'Searches sources and notes. type text matches words; type vector matches meaning and needs an embedding model set up in Open Notebook. ' +
        'Give notebookId to search one notebook; an Open Notebook older than scoped search ignores it and searches all of them, so check each hit\'s source if the scope matters. ' +
        'Results are passed on as Open Notebook returns them, with their ids, ' +
        'so a hit can be read in full with notebook_source_get.',
      input: SearchSchema,
      annotations: READ_ONLY,
      run: async (args) => client.search(args),
    }),
    defineTool({
      name: 'notebook_note_add',
      title: 'Add a note to a notebook',
      description:
        'Adds a note in the user\'s words to ONE notebook: something they told you about past work, what they want or avoid, ' +
        'or interview notes. Notes are searched with sources. Write down what the user said, not your reading of it.',
      input: NoteAddSchema,
      annotations: WRITES,
      run: async (args) => client.addNote(args),
    }),
    ...notebookBulkTools(deps),
  ]
}

/** The tool set over a real client, with the tracker read taken from the database. */
export function notebookToolsFor(client: NotebookClient): ToolDefinition[] {
  return notebookTools({ client, postingKeyOf: findPostingKey })
}
