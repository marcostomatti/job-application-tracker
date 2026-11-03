import { integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

import { textType } from './registries.ts'

/**
 * Reusable text the user writes once and sends many times: a cover letter, an outreach
 * message. An edit never overwrites a row; it writes a new row at `version + 1`, so an earlier
 * wording stays readable. `text_type_id` is nullable because the text type registry ships
 * empty. Bodies are personal, so the table ships empty too.
 */
export const textAsset = pgTable('text_asset', {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  textTypeId: integer('text_type_id').references(() => textType.id),
  label: text().notNull(),
  body: text().notNull(),
  version: integer().notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})
