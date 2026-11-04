import { sql } from 'drizzle-orm'
import {
  boolean,
  date,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core'

import { applyRoute, artefactKind, seniority, workFormat } from './registries.ts'

/** Latin letters followed by combining marks in the Combining Diacritical Marks block. */
const LATIN_DIACRITICS = /(\p{Script=Latin})[\u0300-\u036f]+/gu

/**
 * The key a company is matched on, so two spellings of one employer share it.
 *
 * Steps: decompose (NFKD, which also folds full-width and half-width forms); drop the
 * diacritics that follow a Latin letter, so "Cafe" with an accent matches "Cafe" without;
 * lowercase; collapse each run of characters that are not letters, digits or combining
 * marks to one space; trim; recompose (NFC). Marks after a non-Latin letter are kept,
 * because there they change the letter: a voiced kana and its plain form, or a Devanagari
 * vowel sign, are different names and must stay different keys.
 *
 * A name with no letters or digits at all (only punctuation) would normalise to the empty
 * string, and every such name would then collide. It falls back to the trimmed, lowercased
 * input, so each stays distinct. A blank input still yields the empty string.
 */
export function normaliseName(value: string): string {
  const folded = value
    .normalize('NFKD')
    .replace(LATIN_DIACRITICS, '$1')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ')
    .trim()
    .normalize('NFC')
  return folded === '' ? value.trim().toLowerCase() : folded
}

/**
 * `nameUnresolved` marks a placeholder standing in for an employer not yet known.
 * It is a flag rather than a reserved name, so no wording is baked into code.
 */
export const company = pgTable('company', {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  name: text().notNull(),
  nameNorm: text('name_norm').notNull(),
  nameUnresolved: boolean('name_unresolved').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [unique('company_name_norm_unique').on(table.nameNorm)])

/**
 * One row per role, however often it is reposted: a repost is a new origin row plus a
 * changed `source_hash` on the summary, never a second posting. `disambiguator` is
 * not null with an empty default, because a null would make two blank rows distinct to
 * the unique key and let a duplicate in. Every registry reference is nullable, since the
 * registries ship empty.
 *
 * `priorityRank` is user-owned: the user sets it by hand, and no import may ever write it.
 */
export const posting = pgTable(
  'posting',
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    postingKey: text('posting_key').notNull().unique(),
    companyId: integer('company_id')
      .notNull()
      .references(() => company.id),
    roleTitle: text('role_title').notNull(),
    roleNorm: text('role_norm').notNull(),
    disambiguator: text().notNull().default(''),
    seenAt: date('seen_at', { mode: 'string' }).notNull().default(sql`CURRENT_DATE`),
    deadline: date({ mode: 'string' }),
    city: text(),
    country: text(),
    workFormatId: integer('work_format_id').references(() => workFormat.id),
    seniorityId: integer('seniority_id').references(() => seniority.id),
    applyRouteId: integer('apply_route_id').references(() => applyRoute.id),
    salaryRaw: text('salary_raw'),
    postingAgeRaw: text('posting_age_raw'),
    applicantCountRaw: text('applicant_count_raw'),
    applyContact: text('apply_contact'),
    priorityRank: integer('priority_rank'),
    clientHidden: boolean('client_hidden').notNull().default(false),
    firstImportedAt: timestamp('first_imported_at', { withTimezone: true }).notNull().defaultNow(),
    lastImportedAt: timestamp('last_imported_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('posting_company_role_disambiguator_unique').on(
      table.companyId,
      table.roleNorm,
      table.disambiguator,
    ),
  ],
)

/**
 * The posting stripped of noise but not of substance, and the substrate every later
 * statistic counts over. It is its own table so a wide text payload does not load on every
 * board query and its schema can change on its own migration path. `stack` is tags as data,
 * with no CHECK on their values. `sourceHash` detects a changed posting, which is how a
 * repost shows up.
 */
export const postingSummary = pgTable('posting_summary', {
  postingId: integer('posting_id')
    .primaryKey()
    .references(() => posting.id, { onDelete: 'cascade' }),
  stack: jsonb().notNull().default(sql`'[]'::jsonb`),
  description: text(),
  industry: text(),
  condensed: text().notNull(),
  extra: jsonb().notNull().default(sql`'{}'::jsonb`),
  sourceHash: text('source_hash').notNull(),
  summarisedAt: timestamp('summarised_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * A reference to something that lives elsewhere (a bucket, a drive, a repository): the
 * `locator` points at it and the `accessNote` says how to get in. The row never holds the
 * bytes, and the note never holds a credential.
 */
export const artefact = pgTable('artefact', {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  artefactKindId: integer('artefact_kind_id').references(() => artefactKind.id),
  label: text().notNull(),
  locator: text().notNull(),
  accessNote: text('access_note'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})
