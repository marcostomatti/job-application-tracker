/**
 * Run as a child process by `server.test.ts`. Starts the service (so its log goes to this
 * process's own stdout, where pino writes it and where the parent can read it), sends one
 * request with the right key, one with no key and one with a wrong key, then stops. The key
 * comes from `API_KEY`; the wrong token from `PROBE_WRONG_TOKEN`. Prints nothing itself.
 */
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { startService } from '../../../src/http/server.ts'

const handle = await startService()
const outer = await new Promise<Server>((ready, failed) => {
  const server = handle.app.listen(0, () => ready(server))
  server.once('error', failed)
})
const origin = `http://localhost:${(outer.address() as AddressInfo).port}`

await fetch(`${origin}/api/positions`, { headers: { authorization: `Bearer ${process.env.API_KEY}` } })
await fetch(`${origin}/api/positions`)
await fetch(`${origin}/api/positions`, { headers: { authorization: `Bearer ${process.env.PROBE_WRONG_TOKEN}` } })

outer.closeAllConnections()
await new Promise<void>((done) => outer.close(() => done()))
await handle.stop()
process.exit(0)
