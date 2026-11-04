import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  date,
  foreignKey,
  integer,
  numeric,
  pgTable,
  primaryKey,
  text,
  unique,
} from 'drizzle-orm/pg-core'

import { criteriaSet, detour, requirement } from './criteria.ts'
import { position } from './positions.ts'
import { penaltyKind } from './registries.ts'

/**
 * One scoring pass of one position against one criteria set. A position has many of these,
 * because a score only means something against the set it was scored under. The columns
 * mirror what `scoreAgainstSet` returns. `limiterIsUnknown` says the named limiter is only a
 * requirement nobody has rated yet. The unique key makes a same-day re-score for the same set
 * a no-op, while a genuine re-score on another day is a new row marked `isRescore`.
 */
export const positionScore = pgTable(
  'position_score',
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    positionId: integer('position_id')
      .notNull()
      .references(() => position.id, { onDelete: 'cascade' }),
    criteriaSetId: integer('criteria_set_id')
      .notNull()
      .references(() => criteriaSet.id),
    scoredAt: date('scored_at', { mode: 'string' }).notNull().default(sql`CURRENT_DATE`),
    overall: numeric({ mode: 'number' }),
    limiterRequirementId: integer('limiter_requirement_id'),
    limiterCoverage: numeric('limiter_coverage', { mode: 'number' }),
    limiterIsUnknown: boolean('limiter_is_unknown').notNull().default(false),
    runnerUpRequirementId: integer('runner_up_requirement_id'),
    floor: numeric({ mode: 'number' }),
    ceiling: numeric({ mode: 'number' }),
    recommendApply: boolean('recommend_apply').notNull().default(false),
    isRescore: boolean('is_rescore').notNull().default(false),
    note: text(),
  },
  (table) => [
    unique('position_score_position_set_day_unique').on(
      table.positionId,
      table.criteriaSetId,
      table.scoredAt,
    ),
    // Redundant as a key (id is already unique); it exists so a rating can reference the
    // pair and the database can check the rating's set is the score's set.
    unique('position_score_id_criteria_set_unique').on(table.id, table.criteriaSetId),
    // A limiter must be a requirement of the set being scored. A null limiter skips the check.
    foreignKey({
      name: 'position_score_limiter_set_fk',
      columns: [table.criteriaSetId, table.limiterRequirementId],
      foreignColumns: [requirement.criteriaSetId, requirement.id],
    }),
    foreignKey({
      name: 'position_score_runner_up_set_fk',
      columns: [table.criteriaSetId, table.runnerUpRequirementId],
      foreignColumns: [requirement.criteriaSetId, requirement.id],
    }),
    check('position_score_overall_check', sql`${table.overall} >= 0 AND ${table.overall} <= 1`),
    check('position_score_floor_check', sql`${table.floor} >= 0 AND ${table.floor} <= 1`),
    check('position_score_ceiling_check', sql`${table.ceiling} >= 0 AND ${table.ceiling} <= 1`),
    check(
      'position_score_limiter_coverage_check',
      sql`${table.limiterCoverage} >= 0 AND ${table.limiterCoverage} <= 1`,
    ),
  ],
)

/**
 * A rating is a row per requirement, so adding a criterion adds rows and never a column.
 * It carries the set id as well, so two composite foreign keys can prove the requirement
 * belongs to the same set as the score.
 * `coverage` is nullable on purpose: null means not rated, which is different from 0 (rated,
 * and not covered). `confidence` is an internal discriminator, so a CHECK may list it.
 */
export const positionRating = pgTable(
  'position_rating',
  {
    scoreId: integer('score_id').notNull(),
    criteriaSetId: integer('criteria_set_id').notNull(),
    requirementId: integer('requirement_id').notNull(),
    coverage: numeric({ mode: 'number' }),
    confidence: text().notNull().default('unknown'),
    evidence: text(),
  },
  (table) => [
    primaryKey({ columns: [table.scoreId, table.requirementId] }),
    // The two overlapping foreign keys share criteria_set_id, so the score and the requirement
    // must name the same set. Without them a rating could point at a requirement from a set
    // the score was never made under, and the limiter would name something outside it.
    foreignKey({
      name: 'position_rating_score_set_fk',
      columns: [table.scoreId, table.criteriaSetId],
      foreignColumns: [positionScore.id, positionScore.criteriaSetId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'position_rating_set_requirement_fk',
      columns: [table.criteriaSetId, table.requirementId],
      foreignColumns: [requirement.criteriaSetId, requirement.id],
    }),
    check('position_rating_coverage_check', sql`${table.coverage} >= 0 AND ${table.coverage} <= 1`),
    // The members are RATING_CONFIDENCES (src/schemas/discriminators.ts); tests/data/discriminators.test.ts compares them.
    check(
      'position_rating_confidence_check',
      sql`${table.confidence} IN ('supported', 'partial', 'unknown')`,
    ),
  ],
)

/**
 * How well a position covers one detour of a requirement, under one score. The detour itself
 * (its label and discount) belongs to the criteria set; this is the per-position half, the
 * part `scoreAgainstSet` needs and no other table holds. A row hangs off the rating of the same
 * requirement, so it goes when the rating does, and the second key ties the detour to that
 * requirement, so a coverage cannot name a detour that is a way round some other requirement.
 * `coverage` reads like a rating's: null is not rated, which is different from 0.
 *
 * The key to `detour` is restrictive on purpose (no `ON DELETE`): a stored score's inputs must
 * not vanish underneath it, or history would silently change meaning. It matches the key from
 * `position_rating` to `requirement`. A surface that edits a set's detours must therefore retire
 * one rather than delete it, which needs an archival column `detour` does not have yet.
 */
export const positionRatingDetour = pgTable(
  'position_rating_detour',
  {
    scoreId: integer('score_id').notNull(),
    requirementId: integer('requirement_id').notNull(),
    detourId: integer('detour_id').notNull(),
    coverage: numeric({ mode: 'number' }),
  },
  (table) => [
    primaryKey({ columns: [table.scoreId, table.detourId] }),
    foreignKey({
      name: 'position_rating_detour_rating_fk',
      columns: [table.scoreId, table.requirementId],
      foreignColumns: [positionRating.scoreId, positionRating.requirementId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'position_rating_detour_detour_fk',
      columns: [table.requirementId, table.detourId],
      foreignColumns: [detour.requirementId, detour.id],
    }),
    check('position_rating_detour_coverage_check', sql`${table.coverage} >= 0 AND ${table.coverage} <= 1`),
  ],
)

/**
 * A signed adjustment taken off one score. What kind of penalty it is lives in the
 * `penalty_kind` registry, never in a column name. The kind is required: a penalty row is an
 * application of the vocabulary, so an empty registry means no penalty rows at all. The unique
 * key on score and kind keeps one penalty of each kind per score; the table has its own id
 * only because that suits the query builder.
 */
export const positionPenalty = pgTable(
  'position_penalty',
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    scoreId: integer('score_id')
      .notNull()
      .references(() => positionScore.id, { onDelete: 'cascade' }),
    penaltyKindId: integer('penalty_kind_id')
      .notNull()
      .references(() => penaltyKind.id),
    amount: numeric({ mode: 'number' }).notNull().default(sql`'0'`),
    reason: text(),
  },
  (table) => [
    unique('position_penalty_score_kind_unique').on(table.scoreId, table.penaltyKindId),
    // `<= 0` already rejects NaN (ordered above every number); `> '-Infinity'` rejects the other
    // non-finite value, so an amount is always a finite number.
    check('position_penalty_amount_check', sql`${table.amount} <= 0 AND ${table.amount} > '-Infinity'`),
  ],
)
