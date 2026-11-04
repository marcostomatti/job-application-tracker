import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import express, { type Application } from 'express'

/** What a caller sees of one response: its status and its body, as JSON when it is JSON. */
export interface HttpOutcome {
  readonly status: number
  readonly body: unknown
}

/** A running app and the means to call it and to stop it. */
export interface TestServer {
  request(method: string, path: string, body?: unknown): Promise<HttpOutcome>
  close(): Promise<void>
}

/**
 * Starts a bare Express app holding only a JSON body parser and the routes `register` adds, and
 * listens on a port the operating system picks.
 *
 * The chassis is left out on purpose. These files test the route table and `jsonHandler`, and
 * neither needs helmet, the rate limit, the error handler or the request logger; the assembled
 * service has its own suite, `service.integration.test.ts`, which runs it in a child process.
 * The parser is the one setting the routes depend on, so it matches the chassis's: `express.json`
 * with a 1mb limit.
 */
export async function startTestServer(register: (app: Application) => void): Promise<TestServer> {
  const app = express()
  app.use(express.json({ limit: '1mb' }))
  register(app)
  const server = await listen(app)
  const origin = `http://localhost:${(server.address() as AddressInfo).port}`

  return {
    async request(method, path, body): Promise<HttpOutcome> {
      const response = await fetch(`${origin}${path}`, {
        method,
        ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      })
      const text = await response.text()
      try {
        return { status: response.status, body: JSON.parse(text) }
      } catch {
        return { status: response.status, body: text }
      }
    },
    async close(): Promise<void> {
      server.closeAllConnections()
      await new Promise<void>((done) => server.close(() => done()))
    },
  }
}

function listen(app: Application): Promise<Server> {
  return new Promise((ready, failed) => {
    const server = app.listen(0, () => ready(server))
    server.once('error', failed)
  })
}
