import { join } from 'node:path'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

import type { DrizzleClient } from '../../src/data/client.ts'

const MIGRATIONS_DIR = join(import.meta.dir, '..', '..', 'drizzle')

/** The same server and credentials as DATABASE_URL, pointed at another database. */
function urlFor(databaseName: string): string {
  const base = process.env.DATABASE_URL
  if (!base) throw new Error('DATABASE_URL is not set; a scratch database needs a server to live on.')
  const url = new URL(base)
  url.pathname = `/${databaseName}`
  return url.toString()
}

/**
 * Creates an empty database on the same server, applies every migration to it, runs `body`
 * against it and drops it again, whether or not `body` threw. What it proves is about the
 * migrations alone: the shared dev database holds whatever earlier work left there.
 * The database is named at random, so concurrent runs do not collide, and only a database
 * this call created is ever dropped.
 */
export async function withMigratedScratchDatabase<T>(
  body: (db: DrizzleClient, sql: postgres.Sql, url: string) => Promise<T>,
): Promise<T> {
  const name = `scratch_${crypto.randomUUID().replaceAll('-', '')}`
  const admin = postgres(process.env.DATABASE_URL ?? urlFor(''), { max: 1 })
  await admin.unsafe(`CREATE DATABASE "${name}"`)
  const scratch = postgres(urlFor(name), { max: 1, onnotice: () => {} })
  try {
    const db = drizzle(scratch)
    await migrate(db, { migrationsFolder: MIGRATIONS_DIR })
    return await body(db, scratch, urlFor(name))
  } finally {
    await scratch.end()
    await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`)
    await admin.end()
  }
}
