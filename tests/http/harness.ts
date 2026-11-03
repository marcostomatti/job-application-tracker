import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { createService } from '@open-tomato/service-express'
import type { Application } from 'express'

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
 * A request budget no test reaches. The chassis rate-limits at 100 requests a minute by
 * default, and a file that probes every route and round-trips most of them would meet the
 * limit and read a 429 as a failure of the route.
 */
const UNLIMITED = { max: 1_000_000, windowMs: 60_000 }

/**
 * Starts the real chassis (body parser, error handler and all) with the routes `register` adds,
 * and listens on a port the operating system picks.
 *
 * `createService` already listens on an ephemeral port under `NODE_ENV=test`, but its handle
 * exposes only the Express `app` and `stop()`, never the address, so there is no way to learn
 * where it listens. The same `app` is therefore listened on a second time here, on port 0, which
 * is what makes it reachable by `fetch`. `NODE_ENV` is checked first because outside test mode
 * `createService` calls `process.exit`.
 */
export async function startTestServer(register: (app: Application) => void): Promise<TestServer> {
  if (process.env.NODE_ENV !== 'test') throw new Error('startTestServer needs NODE_ENV=test')
  const handle = await createService({ serviceId: 'http-test', rateLimit: UNLIMITED, register })
  const server = await listen(handle.app)
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
      await handle.stop()
    },
  }
}

function listen(app: Application): Promise<Server> {
  return new Promise((ready, failed) => {
    const server = app.listen(0, () => ready(server))
    server.once('error', failed)
  })
}
