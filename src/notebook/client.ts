import type { ZodType, z } from 'zod'

import { NotebookRequestError, NotebookUnavailableError, NotFoundError } from '../errors.ts'
import type { NotebookConfig } from './config.ts'
import {
  DeleteResponseSchema,
  type NoteRow,
  NoteResponseSchema,
  type NotebookRow,
  NotebookResponseSchema,
  type SearchResult,
  SearchResponseSchema,
  type SourceDetail,
  type SourceRow,
  SourceListResponseSchema,
  SourceResponseSchema,
} from './responses.ts'

/** How long one call waits for the notebook before it reports it unavailable. */
export const DEFAULT_TIMEOUT_MS = 15_000


export interface NotebookClientOptions {
  readonly timeoutMs?: number
}

export interface NewTextSource {
  readonly title: string
  readonly content: string
  readonly notebookIds: readonly string[]
  readonly embed: boolean
}

export interface SourceQuery {
  readonly notebookId?: string
  readonly limit: number
  readonly offset: number
}

export interface SearchQuery {
  readonly query: string
  readonly type: 'text' | 'vector'
  readonly limit: number
  readonly notebookId?: string
  readonly searchSources: boolean
  readonly searchNotes: boolean
}

export interface NewNote {
  readonly notebookId: string
  readonly title?: string
  readonly content: string
}

interface RequestSpec {
  readonly method: 'GET' | 'POST' | 'DELETE'
  readonly path: string
  readonly query?: Record<string, string | undefined>
  readonly body?: unknown
  /** A 404 on this request means the named thing is missing, not that the route is. */
  readonly notFound?: { readonly entity: string; readonly id: string }
}

/**
 * Builds the error a non-2xx answer becomes. The notebook's own `detail` text is never shown:
 * its handlers often build it from an internal exception, which can name a path or a host.
 */
function refusal(status: number, spec: RequestSpec): Error {
  if (status === 404 && spec.notFound) return new NotFoundError(spec.notFound.entity, spec.notFound.id)
  if (status === 401 || status === 403) {
    return new NotebookRequestError(status, `the notebook refused the key (${status}); check OPEN_NOTEBOOK_API_KEY`)
  }
  if (status >= 500) return new NotebookRequestError(status, `the notebook failed the request (${status})`)
  return new NotebookRequestError(status, `the notebook refused the request (${status}); check the ids and values sent`)
}

/** True for the error `fetch` or a body read throws when the timeout signal fires. */
function isTimeout(error: unknown): boolean {
  return error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')
}

/**
 * The tracker's one way to reach Open Notebook's REST API. Each method is one request, sent
 * with the key as a bearer token and a timeout, and its answer is checked against a schema.
 * Every failure is one of three errors a tool result can show as it is: `NotFoundError`,
 * `NotebookRequestError`, or `NotebookUnavailableError`. No method retries and no state is
 * kept between calls, so a notebook that comes back is used again on the next call.
 */
export class NotebookClient {
  private readonly timeoutMs: number

  constructor(
    private readonly config: NotebookConfig,
    options: NotebookClientOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  private async request<S extends ZodType>(spec: RequestSpec, schema: S, timeoutMs = this.timeoutMs): Promise<z.output<S>> {
    const url = new URL(`${this.config.url}${spec.path}`)
    for (const [name, value] of Object.entries(spec.query ?? {})) {
      if (value !== undefined) url.searchParams.set(name, value)
    }
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (this.config.apiKey !== undefined) headers.Authorization = `Bearer ${this.config.apiKey}`
    if (spec.body !== undefined) headers['Content-Type'] = 'application/json'

    // The timeout covers the whole exchange, body included, so a body that stalls is a timeout
    // and not a shape error.
    let status: number
    let body: unknown
    try {
      const response = await fetch(url, {
        method: spec.method,
        headers,
        body: spec.body === undefined ? undefined : JSON.stringify(spec.body),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      })
      status = response.status
      body = response.ok ? await response.json().catch((error: unknown) => (isTimeout(error) ? Promise.reject(error) : undefined)) : undefined
      if (!response.ok) await response.body?.cancel()
    } catch (error: unknown) {
      const reason = isTimeout(error) ? `it did not answer within ${timeoutMs} ms` : 'the connection failed'
      throw new NotebookUnavailableError(reason, { cause: error })
    }
    if (status < 200 || status > 299) throw refusal(status, spec)

    const parsed = schema.safeParse(body)
    if (!parsed.success) throw new NotebookUnavailableError('it answered in a shape this tracker does not know')
    return parsed.data
  }

  /** One cheap authenticated read, for the startup probe; its own short timeout. */
  async ping(timeoutMs: number): Promise<void> {
    await this.request({ method: 'GET', path: '/api/notebooks', query: { archived: 'false' } }, NotebookResponseSchema.array(), timeoutMs)
  }

  listNotebooks(query: { readonly archived?: boolean }): Promise<NotebookRow[]> {
    const archived = query.archived === undefined ? undefined : String(query.archived)
    return this.request({ method: 'GET', path: '/api/notebooks', query: { archived } }, NotebookResponseSchema.array())
  }

  createNotebook(input: { readonly name: string; readonly description: string }): Promise<NotebookRow> {
    return this.request({ method: 'POST', path: '/api/notebooks', body: input }, NotebookResponseSchema)
  }

  listSources(query: SourceQuery): Promise<SourceRow[]> {
    return this.request(
      {
        method: 'GET',
        path: '/api/sources',
        query: { notebook_id: query.notebookId, limit: String(query.limit), offset: String(query.offset) },
      },
      SourceListResponseSchema.array(),
    )
  }

  getSource(id: string): Promise<SourceDetail> {
    return this.request(
      { method: 'GET', path: `/api/sources/${encodeURIComponent(id)}`, notFound: { entity: 'notebook source', id } },
      SourceResponseSchema,
    )
  }

  /** Stores pasted text as a source. Processing runs in the background, so the text may not be searchable yet. */
  addTextSource(input: NewTextSource): Promise<SourceDetail> {
    const body = {
      type: 'text',
      title: input.title,
      content: input.content,
      notebooks: input.notebookIds,
      embed: input.embed,
      async_processing: true,
    }
    return this.request({ method: 'POST', path: '/api/sources/json', body }, SourceResponseSchema)
  }

  async deleteSource(id: string): Promise<void> {
    await this.request(
      { method: 'DELETE', path: `/api/sources/${encodeURIComponent(id)}`, notFound: { entity: 'notebook source', id } },
      DeleteResponseSchema,
    )
  }

  /**
   * Full-text or meaning search. The scope is sent as `notebook_id`, the single-notebook field
   * that upstream added with scoped search. A version older than that ignores the field and
   * searches every notebook; the tool's description says so.
   */
  search(query: SearchQuery): Promise<SearchResult> {
    const body = {
      query: query.query,
      type: query.type,
      limit: query.limit,
      search_sources: query.searchSources,
      search_notes: query.searchNotes,
      ...(query.notebookId === undefined ? {} : { notebook_id: query.notebookId }),
    }
    return this.request({ method: 'POST', path: '/api/search', body }, SearchResponseSchema)
  }

  addNote(input: NewNote): Promise<NoteRow> {
    const body = { title: input.title, content: input.content, note_type: 'human', notebook_id: input.notebookId }
    return this.request({ method: 'POST', path: '/api/notes', body }, NoteResponseSchema)
  }
}
