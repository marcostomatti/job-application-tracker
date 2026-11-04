import { z } from 'zod'

/**
 * The parts of Open Notebook's responses the tracker reads, after `api/models.py` in the
 * upstream repository. Each schema keeps only the fields named here and drops the rest, so a
 * new upstream field changes nothing, and a missing one is caught instead of passed on.
 */

const nullableText = z.string().nullable().optional().transform((value) => value ?? null)

export const NotebookResponseSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable().optional(),
    archived: z.boolean().nullable().optional(),
    updated: nullableText,
    source_count: z.number().nullable().optional(),
    note_count: z.number().nullable().optional(),
  })
  .transform((row) => ({
    id: row.id,
    name: row.name,
    description: row.description ?? '',
    archived: row.archived ?? false,
    sourceCount: row.source_count ?? 0,
    noteCount: row.note_count ?? 0,
    updated: row.updated,
  }))

export type NotebookRow = z.output<typeof NotebookResponseSchema>

const sourceFields = {
  id: z.string(),
  title: nullableText,
  embedded: z.boolean().nullable().optional(),
  embedded_chunks: z.number().nullable().optional(),
  status: nullableText,
  created: nullableText,
  updated: nullableText,
}

export const SourceListResponseSchema = z.object(sourceFields).transform((row) => ({
  id: row.id,
  title: row.title,
  embedded: row.embedded ?? false,
  embeddedChunks: row.embedded_chunks ?? 0,
  status: row.status,
  created: row.created,
  updated: row.updated,
}))

export type SourceRow = z.output<typeof SourceListResponseSchema>

export const SourceResponseSchema = z
  .object({ ...sourceFields, full_text: nullableText, notebooks: z.array(z.string()).nullable().optional(), command_id: nullableText })
  .transform((row) => ({
    id: row.id,
    title: row.title,
    embedded: row.embedded ?? false,
    embeddedChunks: row.embedded_chunks ?? 0,
    status: row.status,
    created: row.created,
    updated: row.updated,
    fullText: row.full_text,
    notebooks: row.notebooks ?? [],
    commandId: row.command_id,
  }))

export type SourceDetail = z.output<typeof SourceResponseSchema>

export const SearchResponseSchema = z
  .object({ results: z.array(z.record(z.string(), z.unknown())), total_count: z.number(), search_type: z.string() })
  .transform((row) => ({ total: row.total_count, searchType: row.search_type, results: row.results }))

export type SearchResult = z.output<typeof SearchResponseSchema>

export const NoteResponseSchema = z
  .object({ id: z.string(), title: nullableText, note_type: nullableText, created: nullableText })
  .transform((row) => ({ id: row.id, title: row.title, noteType: row.note_type, created: row.created }))

export type NoteRow = z.output<typeof NoteResponseSchema>

/** What a delete answers; only that it answered matters. */
export const DeleteResponseSchema = z.unknown()
