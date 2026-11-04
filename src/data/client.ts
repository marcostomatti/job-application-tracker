import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

export type DrizzleClient = ReturnType<typeof drizzle>

type OpenConnection = {
  readonly sql: postgres.Sql
  readonly db: DrizzleClient
}

export class MissingDatabaseUrlError extends Error {
  constructor() {
    super(
      'DATABASE_URL is not set. Copy .env.example to .env, or export DATABASE_URL, ' +
        'before opening the database.',
    )
    this.name = 'MissingDatabaseUrlError'
  }
}

let connection: OpenConnection | undefined

/**
 * Returns the one Drizzle client for this process. DATABASE_URL is read when the
 * client is first opened; later calls reuse the same connection pool.
 */
export function getDb(): DrizzleClient {
  if (connection) return connection.db

  const url = process.env.DATABASE_URL
  if (!url) throw new MissingDatabaseUrlError()

  const sql = postgres(url)
  connection = { sql, db: drizzle(sql) }
  return connection.db
}

/** Closes the pool, so the next getDb() reads DATABASE_URL again. Safe to call twice. */
export async function closeDb(): Promise<void> {
  const open = connection
  connection = undefined
  if (open) await open.sql.end()
}
