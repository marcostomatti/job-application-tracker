import { afterEach, describe, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import { createToken, revokeToken } from '../../src/auth/store.ts'
import { smallBody, startMcpListener, type McpListener } from '../../src/mcp/http-listener.ts'
import { ALL_TOOLS } from '../../src/mcp/tools/index.ts'
import { useSharedScratchDatabase } from './tools/harness.ts'

const database = useSharedScratchDatabase()

const API_KEY = 'k'.repeat(48)

let listener: McpListener | undefined

afterEach(async () => {
  await listener?.stop()
  listener = undefined
})

async function start(): Promise<McpListener> {
  listener = await startMcpListener({ db: database(), apiKey: API_KEY, tools: ALL_TOOLS, port: 0 })
  return listener
}

function urlOf(running: McpListener): URL {
  return new URL(`http://127.0.0.1:${running.port()}/mcp`)
}

/** A connected SDK client that sends `token` as its bearer. */
async function connect(running: McpListener, token: string): Promise<Client> {
  const client = new Client({ name: 'test-client', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(urlOf(running), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  })
  await client.connect(transport)
  return client
}

/** A bare initialize, so a refusal's status and headers can be read. */
function initialize(running: McpListener, headers: Record<string, string>): Promise<Response> {
  return fetch(urlOf(running), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1' } },
    }),
  })
}

describe('the MCP listener', () => {
  test('two clients hold sessions at once, and each lists every tool', async () => {
    const running = await start()
    const { token } = await createToken(database(), 'second client')

    const first = await connect(running, API_KEY)
    const second = await connect(running, token)
    try {
      const [a, b] = await Promise.all([first.listTools(), second.listTools()])

      expect(a.tools).toHaveLength(ALL_TOOLS.length)
      expect(b.tools).toHaveLength(ALL_TOOLS.length)
      expect(running.sessions()).toBe(2)
    } finally {
      await first.close()
      await second.close()
    }
  })

  test('a client that disconnects can connect again without a restart', async () => {
    const running = await start()

    const first = await connect(running, API_KEY)
    await first.close()
    const again = await connect(running, API_KEY)
    try {
      expect((await again.listTools()).tools.length).toBeGreaterThan(0)
    } finally {
      await again.close()
    }
  })

  test('a request without a bearer is refused with 401 and opens no session', async () => {
    const running = await start()

    const response = await initialize(running, {})

    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toBe('Bearer')
    expect(running.sessions()).toBe(0)
  })

  test('past the budget a request gets 429 before its bearer is checked', async () => {
    listener = await startMcpListener({
      db: database(),
      apiKey: API_KEY,
      tools: ALL_TOOLS,
      port: 0,
      rateLimit: { max: 1, windowMs: 60_000 },
    })

    const first = await initialize(listener, {})
    const second = await initialize(listener, { Authorization: `Bearer ${API_KEY}` })

    expect(first.status).toBe(401)
    expect(second.status).toBe(429)
    expect(second.headers.get('retry-after')).toBe('60')
    expect(listener.sessions()).toBe(0)
  })

  test('a refusal reads only a small, sized body', () => {
    expect(smallBody({ headers: {} })).toBe(true)
    expect(smallBody({ headers: { 'content-length': '1024' } })).toBe(true)
    expect(smallBody({ headers: { 'content-length': String(64 * 1024 + 1) } })).toBe(false)
    expect(smallBody({ headers: { 'transfer-encoding': 'chunked' } })).toBe(false)
    expect(smallBody({ headers: { 'content-length': 'many' } })).toBe(false)
  })

  test('a wrong or revoked bearer is refused the same way', async () => {
    const running = await start()
    const { token, summary } = await createToken(database(), 'revoked before use')
    await revokeToken(database(), summary.id)

    const wrong = await initialize(running, { Authorization: 'Bearer not-a-token' })
    const revoked = await initialize(running, { Authorization: `Bearer ${token}` })

    expect(wrong.status).toBe(401)
    expect(revoked.status).toBe(401)
    expect(await wrong.text()).toBe(await revoked.text())
    expect(running.sessions()).toBe(0)
  })
})
