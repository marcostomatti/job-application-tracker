import { boolean, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

/**
 * The columns every registry shares. Each call builds fresh column objects,
 * because a column builder belongs to the one table it is placed in.
 */
const registryColumns = () => ({
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  label: text().notNull(),
  /** A registry row is archived, never deleted, so a row that refers to it keeps its label. */
  archivedAt: timestamp('archived_at', { withTimezone: true }),
})

/** A stable handle the user chooses for a row; code may look rows up by it, never by label. */
const keyColumn = () => text().notNull().unique()

const sortColumn = () => integer().notNull().default(0)

/** The board's columns. `isShortlist` marks where a newly recommended position lands. */
export const phase = pgTable('phase', {
  ...registryColumns(),
  key: keyColumn(),
  sort: sortColumn(),
  isShortlist: boolean('is_shortlist').notNull().default(false),
})

/**
 * `isApplied` protects a position from a re-score once the user has committed;
 * `isTraction` is what the funnel counts as having gone somewhere.
 * `phaseId` is nullable because the phase registry ships empty.
 */
export const stage = pgTable('stage', {
  ...registryColumns(),
  key: keyColumn(),
  phaseId: integer('phase_id').references(() => phase.id),
  sort: sortColumn(),
  isTerminal: boolean('is_terminal').notNull().default(false),
  isRepeatable: boolean('is_repeatable').notNull().default(false),
  isTraction: boolean('is_traction').notNull().default(false),
  isApplied: boolean('is_applied').notNull().default(false),
})

export const layer = pgTable('layer', {
  ...registryColumns(),
  key: keyColumn(),
  sort: sortColumn(),
})

export const route = pgTable('route', registryColumns())

export const setAsideReason = pgTable('set_aside_reason', registryColumns())

export const rejectionReason = pgTable('rejection_reason', registryColumns())

export const penaltyKind = pgTable('penalty_kind', registryColumns())

export const textType = pgTable('text_type', registryColumns())

export const artefactKind = pgTable('artefact_kind', registryColumns())

export const workFormat = pgTable('work_format', registryColumns())

/** Ordered, because comparisons between seniorities read `sort`. */
export const seniority = pgTable('seniority', {
  ...registryColumns(),
  sort: sortColumn(),
})

export const applyRoute = pgTable('apply_route', registryColumns())
