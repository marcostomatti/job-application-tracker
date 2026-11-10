import { join } from 'node:path'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

import { closeDb, getDb, type DrizzleClient } from './client.ts'

/** The migrations `drizzle-kit generate` writes, read by the same journal `drizzle-kit migrate` uses. */
export const MIGRATIONS_DIR = join(import.meta.dir, '..', '..', 'drizzle')

/**
 * Applies every migration the database has not recorded yet, and nothing else. It is
 * drizzle-orm's own migrator over the same folder and the same `drizzle.__drizzle_migrations`
 * table as `bun run db:migrate`, so either one can run against a database the other migrated.
 * It exists so a production image can migrate at start without drizzle-kit, a dev dependency.
 */
export async function runMigrations(db: DrizzleClient): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR })
}

if (import.meta.main) {
  try {
    await runMigrations(getDb())
    process.stderr.write('migrations applied\n')
  } catch (error: unknown) {
    // A driver message can carry the connection's address, so only the error's name is printed.
    process.stderr.write(`migrations failed: ${error instanceof Error ? error.name : 'unknown error'}\n`)
    process.exitCode = 1
  } finally {
    await closeDb()
  }
}
