/**
 * A stand-in for Open Notebook's REST API, so no test reaches a live notebook. It answers the
 * routes the tracker's client calls, with the request and response shapes of Open Notebook's
 * `api/models.py`, from an in-memory store. Every request is recorded so a test can check what
 * was sent, and `stop()` drops the server mid-test to play a notebook that went away.
 */

export interface StubNotebook {
  id: string
  name: string
  description: string
  archived: boolean
}

export interface StubSource {
  id: string
  title: string | null
  full_text: string | null
  notebooks: string[]
  embedded: boolean
  created: string
}

export interface StubNote {
  id: string
  title: string | null
  content: string
  note_type: string
  notebook_id: string | null
}

export interface RecordedRequest {
  readonly method: string
  readonly path: string
  readonly search: string
  readonly authorization: string | null
  readonly body: unknown
}

export interface StubOptions {
  /** When set, every `/api/` route wants `Authorization: Bearer <password>`, as Open Notebook does. */
  readonly password?: string
  /** Makes every `/api/` route answer this status, to play a failing notebook. */
  readonly failWith?: number
}

export interface StubServer {
  readonly url: string
  readonly requests: RecordedRequest[]
  readonly notebooks: StubNotebook[]
  readonly sources: StubSource[]
  readonly notes: StubNote[]
  stop(): Promise<void>
}

const STAMP = '2026-11-04T00:00:00Z'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function detail(status: number, text: string): Response {
  return json({ detail: text }, status)
}

function notebookView(notebook: StubNotebook, sources: StubSource[], notes: StubNote[]): unknown {
  return {
    ...notebook,
    created: STAMP,
    updated: STAMP,
    source_count: sources.filter((source) => source.notebooks.includes(notebook.id)).length,
    note_count: notes.filter((note) => note.notebook_id === notebook.id).length,
  }
}

function sourceListView(source: StubSource): unknown {
  return {
    id: source.id,
    title: source.title,
    topics: [],
    asset: null,
    embedded: source.embedded,
    embedded_chunks: source.embedded ? 1 : 0,
    insights_count: 0,
    created: source.created,
    updated: source.created,
    status: 'completed',
  }
}

function sourceView(source: StubSource): unknown {
  return { ...(sourceListView(source) as object), full_text: source.full_text, notebooks: source.notebooks }
}

export function startStubNotebook(options: StubOptions = {}): StubServer {
  const requests: RecordedRequest[] = []
  const notebooks: StubNotebook[] = []
  const sources: StubSource[] = []
  const notes: StubNote[] = []
  let counter = 0
  const nextId = (table: string): string => `${table}:stub${++counter}`

  async function route(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname
    const method = request.method
    const raw = method === 'GET' || method === 'DELETE' ? '' : await request.text()
    const body: unknown = raw === '' ? undefined : JSON.parse(raw)
    requests.push({ method, path, search: url.search, authorization: request.headers.get('authorization'), body })

    if (path === '/health') return json({ status: 'healthy' })
    if (!path.startsWith('/api/')) return detail(404, 'Not Found')
    if (options.password !== undefined && request.headers.get('authorization') !== `Bearer ${options.password}`) {
      return detail(401, 'Missing authorization header')
    }
    if (options.failWith !== undefined) return detail(options.failWith, 'Search failed: secret internals')

    if (path === '/api/notebooks' && method === 'GET') {
      const archived = url.searchParams.get('archived')
      const kept = archived === null ? notebooks : notebooks.filter((n) => String(n.archived) === archived)
      return json(kept.map((n) => notebookView(n, sources, notes)))
    }
    if (path === '/api/notebooks' && method === 'POST') {
      const input = body as { name: string; description?: string }
      const created: StubNotebook = { id: nextId('notebook'), name: input.name, description: input.description ?? '', archived: false }
      notebooks.push(created)
      return json(notebookView(created, sources, notes))
    }
    if (path === '/api/sources' && method === 'GET') {
      const notebookId = url.searchParams.get('notebook_id')
      const limit = Number(url.searchParams.get('limit') ?? '50')
      const offset = Number(url.searchParams.get('offset') ?? '0')
      if (limit < 1 || limit > 100) return detail(422, 'limit must be between 1 and 100')
      const kept = notebookId === null ? sources : sources.filter((s) => s.notebooks.includes(notebookId))
      return json(kept.slice(offset, offset + limit).map(sourceListView))
    }
    if (path === '/api/sources/json' && method === 'POST') {
      const input = body as { type: string; title?: string; content?: string; notebooks?: string[]; embed?: boolean }
      if (input.type !== 'text') return detail(400, 'only text sources in the stub')
      for (const id of input.notebooks ?? []) {
        if (!notebooks.some((n) => n.id === id)) return detail(404, `Notebook ${id} not found`)
      }
      const created: StubSource = {
        id: nextId('source'),
        title: input.title ?? null,
        full_text: input.content ?? null,
        notebooks: input.notebooks ?? [],
        embedded: input.embed === true,
        created: STAMP,
      }
      sources.push(created)
      return json({ ...(sourceView(created) as object), command_id: 'command:stub', status: 'new' })
    }
    const sourceMatch = /^\/api\/sources\/([^/]+)$/.exec(path)
    if (sourceMatch) {
      const id = decodeURIComponent(sourceMatch[1] ?? '')
      const index = sources.findIndex((s) => s.id === id)
      const found = sources[index]
      if (!found) return detail(404, 'Source not found')
      if (method === 'GET') return json(sourceView(found))
      if (method === 'DELETE') {
        sources.splice(index, 1)
        return json({ message: 'Source deleted successfully' })
      }
    }
    if (path === '/api/search' && method === 'POST') {
      const input = body as { query: string; type?: string; limit?: number; notebook_id?: string }
      const needle = input.query.toLowerCase()
      const results = sources
        .filter((s) => input.notebook_id === undefined || s.notebooks.includes(input.notebook_id))
        .filter((s) => (s.full_text ?? '').toLowerCase().includes(needle))
        .slice(0, input.limit ?? 100)
        .map((s) => ({ id: s.id, parent_id: s.id, title: s.title, relevance: 1, matches: [s.full_text] }))
      return json({ results, total_count: results.length, search_type: input.type ?? 'text' })
    }
    if (path === '/api/notes' && method === 'POST') {
      const input = body as { title?: string; content: string; note_type?: string; notebook_id?: string }
      const created: StubNote = {
        id: nextId('note'),
        title: input.title ?? null,
        content: input.content,
        note_type: input.note_type ?? 'human',
        notebook_id: input.notebook_id ?? null,
      }
      notes.push(created)
      return json({ id: created.id, title: created.title, content: created.content, note_type: created.note_type, created: STAMP, updated: STAMP })
    }
    return detail(404, 'Not Found')
  }

  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: route })
  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    notebooks,
    sources,
    notes,
    async stop() {
      await server.stop(true)
    },
  }
}
