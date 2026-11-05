import { integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

/**
 * One row per signed-in browser. The cookie carries a random id; only its SHA-256 is stored,
 * so a copy of the table (a backup, say) cannot be replayed as a cookie. A session ends when
 * `expires_at` passes, when the user signs out (the row is deleted), or when
 * `bun run reset-credentials` empties the table.
 */
export const authSession = pgTable('auth_session', {
  idHash: text('id_hash').primaryKey(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
})

/**
 * A named API token a signed-in user minted for an agent or an HTTP client. The token is shown
 * once at creation; only its SHA-256 is kept, beside the first characters (`prefix`) so the list
 * can tell two tokens apart. Revoking sets `revoked_at` and keeps the row, so the list still
 * shows what existed; `bun run reset-credentials` deletes every row.
 */
export const apiToken = pgTable('api_token', {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  name: text().notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  prefix: text().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
})
