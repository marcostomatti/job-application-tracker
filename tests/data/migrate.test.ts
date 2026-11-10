import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import { MIGRATIONS_DIR, runMigrations } from '../../src/data/migrate.ts'

/** How many migrations the journal lists, which is how many rows a full run records. */
function journalLength(): number {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8')) as {
    entries: unknown[]
  }
  return journal.entries.length
}

/** An empty database on the DATABASE_URL server, dropped again after `body`. */
async function withEmptyDatabase(body: (url: string) => Promise<void>): Promise<void> {
  const base = process.env.DATABASE_URL
  if (!base) throw new Error('DATABASE_URL is not set; an empty database needs a server to live on.')
  const name = `migrate_${crypto.randomUUID().replaceAll('-', '')}`
  const admin = postgres(base, { max: 1 })
  await admin.unsafe(`CREATE DATABASE "${name}"`)
  const url = new URL(base)
  url.pathname = `/${name}`
  try {
    await body(url.toString())
  } finally {
    await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`)
    await admin.end()
  }
}

describe('runMigrations', () => {
  test('applies every migration to an empty database, and a second run applies none', async () => {
    await withEmptyDatabase(async (url) => {
      const sql = postgres(url, { max: 1, onnotice: () => {} })
      try {
        const db = drizzle(sql)

        await runMigrations(db)
        await runMigrations(db)

        const [row] = await sql<{ count: number }[]>`select count(*)::int as count from drizzle.__drizzle_migrations`
        expect(row?.count).toBe(journalLength())
        const [table] = await sql<{ exists: boolean }[]>`select to_regclass('public.company') is not null as exists`
        expect(table?.exists).toBe(true)
      } finally {
        await sql.end()
      }
    })
  })
})
