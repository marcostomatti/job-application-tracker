import { index, integer, pgTable, primaryKey, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'

import { posting } from './postings.ts'
import { textType } from './registries.ts'

/** The unique index on `(label, version)`, named once so the repository can recognise its violation. */
export const LABEL_VERSION_INDEX = 'text_asset_label_version_unique'

/**
 * Reusable text the user writes once and sends many times: a cover letter, an outreach
 * message. An edit never overwrites a row; it writes a new row at `version + 1`, so an earlier
 * wording stays readable. `text_type_id` is nullable because the text type registry ships
 * empty. Bodies are personal, so the table ships empty too.
 *
 * The versions of one text are the rows that share a `label`: the label is the name the user
 * gave it, and no column links a row to its predecessor. The unique index on `(label, version)`
 * is what keeps two concurrent edits from both claiming the same next version; the loser fails
 * against it and is reported as a conflict.
 */
export const textAsset = pgTable(
  'text_asset',
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    textTypeId: integer('text_type_id').references(() => textType.id),
    label: text().notNull(),
    body: text().notNull(),
    version: integer().notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex(LABEL_VERSION_INDEX).on(table.label, table.version)],
)

/**
 * Which version of a text was used for which posting (spec section 7.8). A link names the
 * version row, because that is the wording that was sent; a later edit writes a new row and
 * leaves the link where it was. The key is the pair, so a posting links one version once. The key
 * leads with the text, so the posting side has an index of its own for `text_list` by posting.
 */
export const textAssetPosting = pgTable(
  'text_asset_posting',
  {
    textAssetId: integer('text_asset_id')
      .notNull()
      .references(() => textAsset.id),
    postingId: integer('posting_id')
      .notNull()
      .references(() => posting.id),
    linkedAt: timestamp('linked_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.textAssetId, table.postingId] }),
    index('text_asset_posting_posting_idx').on(table.postingId),
  ],
)
