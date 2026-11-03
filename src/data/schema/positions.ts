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

/**
 * The key a company is matched on: decomposed (NFKD), accents dropped, lowercased, and each
 * run of characters that are not letters or digits collapsed to one space. Letters and digits
 * are matched as Unicode classes, so a name in any script keeps its content. Two spellings of
 * one employer land on the same string, which `company.name_norm` is unique on.
 */
export function normaliseName(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
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
 * changed `source_hash` on the summary, never a second position. `disambiguator` is
 * not null with an empty default, because a null would make two blank rows distinct to
 * the unique key and let a duplicate in. Every registry reference is nullable, since the
 * registries ship empty.
 *
 * `priorityRank` is user-owned: the user sets it by hand, and no import may ever write it.
 */
export const position = pgTable(
  'position',
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    positionKey: text('position_key').notNull().unique(),
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
    unique('position_company_role_disambiguator_unique').on(
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
export const positionSummary = pgTable('position_summary', {
  positionId: integer('position_id')
    .primaryKey()
    .references(() => position.id, { onDelete: 'cascade' }),
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
