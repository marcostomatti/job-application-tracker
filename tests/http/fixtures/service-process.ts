/**
 * Run as a child process by `service-process.ts`. Starts the service, so everything it logs goes
 * to this process's stdout, where the parent reads it. Once the service listens, one line,
 * `{"fixture":"listening","origin":…}`, says where; the parent sends its requests there and stops
 * the service by closing this process's stdin. A start that fails writes
 * `{"fixture":"failed","message":…}` and exits 1. `FIXTURE_WEB_DIST`, when set, is the web bundle
 * directory to pass. Prints nothing else itself.
 */
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { startService } from '../../../src/http/server.ts'

const report = (line: object): void => void process.stdout.write(`${JSON.stringify(line)}\n`)

const webDist = process.env.FIXTURE_WEB_DIST
const handle = await startService(webDist === undefined ? {} : { webDist }).catch((error: unknown) => {
  report({ fixture: 'failed', message: error instanceof Error ? error.message : String(error) })
  process.exit(1)
})
// The chassis binds an ephemeral port under NODE_ENV=test and never says which, so the app is
// listened on a second time, on a port this process can report.
const outer = await new Promise<Server>((ready, failed) => {
  const server = handle.app.listen(0, () => ready(server))
  server.once('error', failed)
})
report({ fixture: 'listening', origin: `http://localhost:${(outer.address() as AddressInfo).port}` })

// The parent writes nothing; the stream ends when it closes stdin.
for await (const _chunk of Bun.stdin.stream()) void _chunk

outer.closeAllConnections()
await new Promise<void>((done) => outer.close(() => done()))
await handle.stop()
process.exit(0)
