import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core'

import type { DrizzleClient } from '../client.ts'
import { layer } from './registries.ts'

/**
 * The versioned unit of scoring. A position's score only means something against
 * the whole set it was scored under, so a new version is a new set, and old
 * versions stay. `applyThreshold` is null until the user sets a bar, which is
 * how a vanilla pack ships.
 */
export const criteriaSet = pgTable(
  'criteria_set',
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    name: text().notNull(),
    version: integer().notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    applyThreshold: numeric('apply_threshold'),
    isDefault: boolean('is_default').notNull().default(false),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (table) => [
    unique('criteria_set_name_version_unique').on(table.name, table.version),
    // A bar above 1 would stop anything ever being recommended; null means no bar yet.
    check(
      'criteria_set_apply_threshold_check',
      sql`${table.applyThreshold} >= 0 AND ${table.applyThreshold} <= 1`,
    ),
  ],
)

/**
 * `kind` is an internal discriminator the scoring code branches on, so it is the
 * one vocabulary a CHECK may enumerate. `anchors` says what a coverage of 0, 0.5
 * and 1 mean for this requirement; it is the rubric, kept apart from the weight,
 * which is judgement. `layerId` and `weight` are nullable because the layer
 * registry ships empty and a pack carries meaning without carrying opinion.
 */
export const requirement = pgTable(
  'requirement',
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    criteriaSetId: integer('criteria_set_id')
      .notNull()
      .references(() => criteriaSet.id, { onDelete: 'cascade' }),
    layerId: integer('layer_id').references(() => layer.id),
    key: text().notNull(),
    label: text().notNull(),
    kind: text().notNull().default('soft'),
    weight: numeric(),
    anchors: jsonb().notNull(),
    sort: integer().notNull().default(0),
  },
  (table) => [
    unique('requirement_criteria_set_id_key_unique').on(table.criteriaSetId, table.key),
    check('requirement_kind_check', sql`${table.kind} IN ('gate', 'soft')`),
    // A negative weight is ignored by the overall yet still ranked by the limiter.
    check('requirement_weight_check', sql`${table.weight} >= 0`),
  ],
)

/**
 * A way round a requirement. `discount` is how much of the detour's coverage is
 * lost, so a detour can lift a gate but never to full strength. The cost has no
 * default unit, because naming one would be the user's vocabulary.
 */
export const detour = pgTable(
  'detour',
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    requirementId: integer('requirement_id')
      .notNull()
      .references(() => requirement.id, { onDelete: 'cascade' }),
    label: text().notNull(),
    discount: numeric().notNull(),
    costAmount: numeric('cost_amount'),
    costUnit: text('cost_unit'),
  },
  (table) => [check('detour_discount_check', sql`${table.discount} >= 0 AND ${table.discount} <= 1`)],
)

const UNIQUE_VIOLATION = '23505'
const NAME_VERSION_CONSTRAINT = 'criteria_set_name_version_unique'

/**
 * Raised when a set with this name and version already exists. It is its own
 * class so a retried bulk insert can treat it as a no-op, which it cannot do if
 * the error is indistinguishable from a real failure.
 */
export class CriteriaSetConflictError extends Error {
  constructor(
    readonly setName: string,
    readonly version: number,
    options?: ErrorOptions,
  ) {
    super(`A criteria set named "${setName}" at version ${version} already exists.`, options)
    this.name = 'CriteriaSetConflictError'
  }
}

type DriverFault = { code?: string; constraint_name?: string }

/** Drizzle wraps the driver error as `cause`; accept the bare driver error too. */
function isNameVersionConflict(error: unknown): boolean {
  const candidates = [error, error instanceof Error ? error.cause : undefined]
  return candidates.some((candidate) => {
    const fault = candidate as DriverFault | null | undefined
    return fault?.code === UNIQUE_VIOLATION && fault.constraint_name === NAME_VERSION_CONSTRAINT
  })
}

type NewCriteriaSet = typeof criteriaSet.$inferInsert
type StoredCriteriaSet = typeof criteriaSet.$inferSelect

/** Anything that can run an insert: the client or an open transaction. */
type Inserter = Pick<DrizzleClient, 'insert'>

/**
 * Inserts a criteria set. A duplicate name and version becomes a
 * `CriteriaSetConflictError`; any other failure is rethrown unchanged.
 */
export async function insertCriteriaSet(
  db: Inserter,
  values: NewCriteriaSet,
): Promise<StoredCriteriaSet> {
  try {
    const [created] = await db.insert(criteriaSet).values(values).returning()
    if (!created) throw new Error('The criteria set insert returned no row.')
    return created
  } catch (error) {
    if (isNameVersionConflict(error)) {
      throw new CriteriaSetConflictError(values.name, values.version ?? 1, { cause: error })
    }
    throw error
  }
}
