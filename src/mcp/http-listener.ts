import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { createHttpSessions } from '@open-tomato/service-mcp'

import packageJson from '../../package.json' with { type: 'json' }
import { bearerCredentialOf } from '../auth/access.ts'
import type { Db } from '../data/repositories/db.ts'
import { lazyLogger, type Log } from '../logging.ts'
import { registerTools, type ToolDefinition } from './register.ts'

const defaultLogger = lazyLogger('mcp-http')

/** The id clients see in `initialize`: the name and version the stdio server reports too. */
const SERVER_INFO = { name: 'job-application-tracker', version: packageJson.version } as const

/**
 * A JSON-RPC error body for a refused request. One fixed text for every refusal, so a client
 * never learns whether the bearer was missing, malformed, wrong or revoked.
 */
const UNAUTHORIZED_BODY = JSON.stringify({
  jsonrpc: '2.0',
  error: { code: -32001, message: 'a valid API key or API token is required' },
  id: null,
})
const INTERNAL_BODY = JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'internal error' }, id: null })
const TOO_MANY_BODY = JSON.stringify({ jsonrpc: '2.0', error: { code: -32029, message: 'too many requests' }, id: null })

/**
 * The request budget, the web app's own: 1,000 a minute, far above what a few agents send and
 * still a bound on how often a guessed bearer can reach the database. It counts every request
 * on the port, not one client's, because behind a proxy every client has the proxy's address.
 */
export const DEFAULT_MCP_RATE_LIMIT = { max: 1_000, windowMs: 60_000 } as const

/**
 * The most a refusal reads of a body before answering. Reading lets the status land; past
 * this, the connection is closed instead, so a client cannot keep a refused request streaming.
 */
const MAX_DRAINED_BYTES = 64 * 1024

export interface McpListenerOptions {
  readonly db: Db
  /** The `API_KEY`, or `undefined` when only minted API tokens open the listener. */
  readonly apiKey: string | undefined
  readonly tools: readonly ToolDefinition[]
  /** The port to listen on; 0 picks a free one, which `port()` then reports. */
  readonly port: number
  /** Requests allowed per window across the port. Defaults to `DEFAULT_MCP_RATE_LIMIT`. */
  readonly rateLimit?: { readonly max: number; readonly windowMs: number }
  readonly logger?: Pick<Log, 'error'>
}

export interface McpListener {
  /** The port the listener is bound to. */
  port(): number
  /** The number of MCP sessions open right now. */
  sessions(): number
  /** Ends every session, then closes the port. */
  stop(): Promise<void>
}

/** Whether the request declares a body small enough to read before refusing it. */
export function smallBody(req: Pick<IncomingMessage, 'headers'>): boolean {
  if (req.headers['transfer-encoding'] !== undefined) return false
  const length = Number(req.headers['content-length'] ?? 0)
  return Number.isFinite(length) && length <= MAX_DRAINED_BYTES
}

/**
 * Answers with a fixed JSON body. A small body is read first so the status lands; a large or
 * unsized one is not read, and the connection closes once the answer is sent.
 */
function refuse(req: IncomingMessage, res: ServerResponse, status: number, body: string): void {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (status === 401) headers['WWW-Authenticate'] = 'Bearer'
  if (status === 429) headers['Retry-After'] = '60'
  if (smallBody(req)) {
    req.resume()
  } else {
    headers.Connection = 'close'
    res.once('finish', () => req.destroy())
  }
  res.writeHead(status, headers).end(body)
}

/** A fixed-window count of requests; `allow()` is false once the window's budget is spent. */
function fixedWindow(limit: { readonly max: number; readonly windowMs: number }): { allow(): boolean } {
  let windowStart = Date.now()
  let used = 0
  return {
    allow: () => {
      const now = Date.now()
      if (now - windowStart >= limit.windowMs) {
        windowStart = now
        used = 0
      }
      used += 1
      return used <= limit.max
    },
  }
}

/**
 * Starts the MCP server over HTTP on its own port, with one MCP session per client. Every
 * request must carry `Authorization: Bearer` with the `API_KEY` or a minted, unrevoked API
 * token, checked by the same function `/api` uses; anything else is a 401 before the request
 * reaches a session. A plain `node:http` server and not a route on the web app, because the
 * web app parses JSON bodies before its routes run and the session table reads the body itself.
 */
export async function startMcpListener(opts: McpListenerOptions): Promise<McpListener> {
  const log = opts.logger ?? defaultLogger()
  const sessions = createHttpSessions({
    createSessionServer: () => {
      const server = new McpServer(SERVER_INFO)
      registerTools(server, opts.db, opts.tools)
      return server
    },
    onError: (error: unknown) => {
      log.error({ reason: error instanceof Error ? error.name : 'unknown' }, 'an MCP session did not open')
    },
  })

  const budget = fixedWindow(opts.rateLimit ?? DEFAULT_MCP_RATE_LIMIT)

  const httpServer = createServer((req, res) => {
    // Counted before the credential check, so a stream of guesses never reaches the database.
    if (!budget.allow()) {
      refuse(req, res, 429, TOO_MANY_BODY)
      return
    }
    void (async () => {
      let credential: Awaited<ReturnType<typeof bearerCredentialOf>>
      try {
        credential = await bearerCredentialOf(req.headers.authorization, opts.db, opts.apiKey)
      } catch (error: unknown) {
        log.error({ reason: error instanceof Error ? error.name : 'unknown' }, 'the credential check failed')
        refuse(req, res, 500, INTERNAL_BODY)
        return
      }
      if (credential === undefined) {
        refuse(req, res, 401, UNAUTHORIZED_BODY)
        return
      }
      await sessions.handleRequest(req, res)
    })().catch((error: unknown) => {
      log.error({ reason: error instanceof Error ? error.name : 'unknown' }, 'an MCP request failed')
      if (!res.headersSent) refuse(req, res, 500, INTERNAL_BODY)
      else res.end()
    })
  })

  await new Promise<void>((ready, failed) => {
    httpServer.once('error', failed)
    httpServer.listen(opts.port, () => {
      httpServer.off('error', failed)
      ready()
    })
  })
  // After the start, a server error is logged by name; before it, it rejected the start above.
  httpServer.on('error', (error: Error) => log.error({ reason: error.name }, 'the MCP listener failed'))

  return {
    port: () => (httpServer.address() as AddressInfo).port,
    sessions: () => sessions.count(),
    stop: async () => {
      await sessions.closeAll()
      // Streams a session left open would keep close() waiting.
      httpServer.closeAllConnections()
      await new Promise<void>((done) => httpServer.close(() => done()))
    },
  }
}
