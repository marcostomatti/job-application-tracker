import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import { createDependency, createService, type ServiceHandle } from '@open-tomato/service-express'
import { createLogger } from '@open-tomato/service-logger'
import { sql } from 'drizzle-orm'
import express from 'express'

import { requireApiKey } from '../auth/middleware.ts'
import { closeDb, getDb } from '../data/client.ts'
import { mountRoutes } from './routes/index.ts'

/** The port used when neither the caller nor `PORT` names one. The MCP server's HTTP mode takes 8080 and 3001. */
const DEFAULT_PORT = 3000

const MAX_PORT = 65_535

/**
 * The request budget per window. The chassis default is 100 a minute, and a board that loads
 * several routes at once, or is reloaded a few times in a row, would meet it and read a 429 as
 * a fault. 1,000 a minute is about 17 a second: far above one person's use, and still a bound.
 * The limit is not the defence against guessing the key, which is long and random.
 */
const RATE_LIMIT = { max: 1_000, windowMs: 60_000 } as const

/** Where the built web app will be, once the web plan produces it. Absent today. */
const DEFAULT_WEB_DIST = resolve(import.meta.dir, '../web/dist')

export interface StartOptions {
  /** The port to listen on. Defaults to `PORT`, then 3000. Ignored under `NODE_ENV=test`, which binds an ephemeral one. */
  readonly port?: number
  /** The directory holding the built web app. Defaults to `src/web/dist`; nothing is served when it does not exist. */
  readonly webDist?: string
}

/** Thrown before anything is opened when no API key is configured. Its message carries no key. */
export class MissingApiKeyError extends Error {
  constructor() {
    super(
      'API_KEY is not set, so the service will not start. Run `bun run setApiKey --burn-after-reading` ' +
        'to write one into .env.',
    )
    this.name = 'MissingApiKeyError'
  }
}

/**
 * The key clients must present. The service refuses to start without one, and does not run
 * open, because `createService` listens on every network interface and takes no host: with
 * no key, the 23 routes (writes included) would be reachable from any machine on the network.
 */
function requiredApiKey(env: NodeJS.ProcessEnv): string {
  const key = env.API_KEY
  if (key === undefined || key === '') throw new MissingApiKeyError()
  return key
}

/** The port from the caller, else `PORT`, else the default; a `PORT` that is not a port number is refused. */
function resolvePort(requested: number | undefined, env: NodeJS.ProcessEnv): number {
  if (requested !== undefined) return requested
  const raw = env.PORT
  if (raw === undefined || raw === '') return DEFAULT_PORT
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > MAX_PORT) {
    throw new Error(`PORT must be a whole number from 1 to ${MAX_PORT}`)
  }
  return port
}

/**
 * The Postgres pool as a chassis dependency, so it is started before the server listens and
 * stopped after the server has drained. Starting it runs one query, so a database that is down
 * stops the service at startup and not at the first request. The chassis exits with only the
 * dependency's name in the log, so the failure is logged here, by code and never by message,
 * because a driver message can carry the connection's address.
 */
function postgresDependency(db: ReturnType<typeof getDb>): ReturnType<typeof createDependency> {
  return createDependency({
    name: 'postgres',
    client: db,
    onStart: async () => {
      try {
        await db.execute(sql`select 1`)
      } catch (error: unknown) {
        const code = (error as { code?: unknown }).code
        createLogger('server').error({ code: typeof code === 'string' ? code : 'unknown' }, 'database unreachable')
        await closeDb()
        throw new Error('the database is unreachable; check DATABASE_URL and that Postgres is running')
      }
    },
    onStop: closeDb,
  })
}

/**
 * Starts the internal HTTP service: the chassis (health, body parser, rate limit, error
 * handler), the API key on `/api`, the 23 routes, and the web bundle when one exists.
 *
 * Auth is only `requireApiKey`. `auth` is left unset and `ctx.requireAuth` is never mounted,
 * because with no auth service configured the chassis's `requireAuth` allows every request.
 * `cors` is unset too: the app and the API share one origin and one port.
 */
export async function startService(opts: StartOptions = {}): Promise<ServiceHandle> {
  const apiKey = requiredApiKey(process.env)
  const port = resolvePort(opts.port, process.env)
  const webDist = opts.webDist ?? DEFAULT_WEB_DIST
  const db = getDb()

  return createService({
    serviceId: 'job-application-tracker',
    port,
    rateLimit: RATE_LIMIT,
    dependencies: [postgresDependency(db)],
    register: (app, { logger }) => {
      app.use('/api', requireApiKey(apiKey))
      mountRoutes(app, db)
      if (existsSync(webDist)) {
        app.use(express.static(webDist))
      } else {
        logger.info({ webDist: 'absent' }, 'no web bundle found; serving the API only')
      }
    },
  })
}

if (import.meta.main) {
  startService().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
}
