import { and, Column, eq, isNull, type InferInsertModel, type InferSelectModel } from 'drizzle-orm'
import type { PgColumn } from 'drizzle-orm/pg-core'

import { ArchivedError, ConflictError, NotFoundError } from '../../errors.ts'
import type { RegistryRowInputOf, RegistrySchemaName } from '../../schemas/registries.ts'
import { isUniqueViolation } from '../driver-faults.ts'
import {
  applyRoute,
  artefactKind,
  layer,
  penaltyKind,
  phase,
  rejectionReason,
  route,
  seniority,
  setAsideReason,
  stage,
  textType,
  workFormat,
} from '../schema/registries.ts'
import type { Db } from './db.ts'

/**
 * What all twelve share: the three columns `registryColumns()` gives every registry.
 * Constraining the record to this, rather than to one table type, is what lets the four
 * wider registries keep their own columns while the record still rejects a non-registry.
 */
type SharedRegistryColumns = {
  readonly id: PgColumn
  readonly label: PgColumn
  readonly archivedAt: PgColumn
}

/**
 * Every registry, keyed by the name the surface passes as a parameter. The name is a key
 * into this record and nothing else: a table is never assembled from a string, and no
 * behaviour here reads a row's own `key` or `label`.
 *
 * It is a literal object checked against the schema record, so a registry added to one of
 * the two and not the other is a type error rather than a runtime surprise: a missing
 * table fails the `Record`, and a thirteenth table fails the excess-property check.
 */
export const REGISTRY_TABLES = {
  apply_route: applyRoute,
  artefact_kind: artefactKind,
  layer,
  penalty_kind: penaltyKind,
  phase,
  rejection_reason: rejectionReason,
  route,
  seniority,
  set_aside_reason: setAsideReason,
  stage,
  text_type: textType,
  work_format: workFormat,
} satisfies Record<RegistrySchemaName, SharedRegistryColumns>

export type RegistryName = keyof typeof REGISTRY_TABLES

/** The table of one named registry; the twelve are not one shape. */
type RegistryTable<N extends RegistryName> = (typeof REGISTRY_TABLES)[N]

/**
 * A row of the registry `N`, with that registry's own columns: a phase keeps its
 * `isShortlist`, a seniority its `sort`, and neither is flattened to id and label.
 */
export type RegistryRowOf<N extends RegistryName> = InferSelectModel<RegistryTable<N>>

/** A row of some registry, for code that holds one without knowing which. */
export type RegistryRow = RegistryRowOf<RegistryName>

/** Options a caller may leave out entirely; archived rows are hidden unless asked for. */
export type ListRegistryOptions = { readonly includeArchived?: boolean }

/**
 * Registry columns that name a row in another registry. A stage naming its phase is the
 * one such column among the twelve, and it is listed as data so the check below stays a
 * lookup rather than a branch per registry.
 */
const REGISTRY_REFERENCES: Partial<Record<RegistryName, Readonly<Record<string, RegistryName>>>> = {
  stage: { phaseId: 'phase' },
}

/**
 * The table shape the query builder is given. Drizzle types a query against one concrete
 * table, and a table picked at run time out of a record of twelve is a union of twelve,
 * which its builders will not take. So every query here is typed against the narrowest
 * registry — the three shared columns and nothing else.
 *
 * The casts that buys come in three kinds, and every one of them is in this file:
 * the table going into a builder (`tableFor`), the values going into an insert
 * (`QueryTableInsert`), and each row coming back out, cast to the row type of the table
 * actually queried. None of it reaches a caller, who gets `RegistryRowOf<N>` with that
 * registry's own columns. They are sound because the table the cast names and the table
 * the statement ran against are the same one, chosen by `name` a line earlier.
 */
type QueryTable = (typeof REGISTRY_TABLES)['route']

/** The insert shape of that narrowest table; a wider registry's own columns ride along. */
type QueryTableInsert = InferInsertModel<QueryTable>

function tableFor(name: RegistryName): QueryTable {
  return REGISTRY_TABLES[name] as QueryTable
}

/**
 * The unique columns of one registry, read off the table definition so no constraint name
 * is assembled from a string. Today `key` on `phase`, `stage` and `layer` is the only one,
 * and the other nine registries have no column that can collide. Every unique column is
 * collected rather than the first, so a registry that later gains a second one still
 * matches its own violation instead of falling through as an internal error.
 */
type UniqueColumn = { readonly property: string; readonly constraint: string }

function uniqueColumnsOf(name: RegistryName): readonly UniqueColumn[] {
  return Object.entries(REGISTRY_TABLES[name]).flatMap(([property, column]) =>
    column instanceof Column && column.isUnique && column.uniqueName
      ? [{ property, constraint: column.uniqueName }]
      : [],
  )
}

/**
 * What a conflict names. Postgres reports the violated constraint and not the row, so a
 * message can only narrow the values the call carried and must claim no more than that:
 * a single value is the offender, a handful are candidates of which exactly one collided,
 * and a longer call gets the row count, because a list of keys no reader would scan is
 * worth less than the count. A call whose rows carry no such value at all — which only a
 * caller bypassing the registry's schema can produce — reads as the count too.
 */
const KEYS_NAMED_IN_A_CONFLICT = 5

function conflictingKeys(rows: readonly Readonly<Record<string, unknown>>[], property: string): string {
  const keys = [
    ...new Set(rows.map((row) => row[property]).filter((value): value is string => typeof value === 'string')),
  ]
  const [only] = keys
  if (only !== undefined && keys.length === 1) return only
  if (keys.length === 0 || keys.length > KEYS_NAMED_IN_A_CONFLICT) {
    return `in one of the ${rows.length} rows this call carried`
  }
  return `one of: ${keys.join(', ')}`
}

/** The order a pick-list reads in: the user's `sort` where the registry has one, then id. */
function orderOf(name: RegistryName): PgColumn[] {
  const table = REGISTRY_TABLES[name]
  return 'sort' in table ? [table.sort, table.id] : [table.id]
}

/**
 * The rows of one registry. Archived rows are left out by default, because a new write
 * must not be able to pick one; `includeArchived` is how a read that renders a historical
 * reference gets the label of a row that was archived after it was referenced.
 */
export async function listRegistry<N extends RegistryName>(
  db: Db,
  name: N,
  opts: ListRegistryOptions = {},
): Promise<RegistryRowOf<N>[]> {
  const table = tableFor(name)
  const rows = await db
    .select()
    .from(table)
    .where(opts.includeArchived ? undefined : isNull(table.archivedAt))
    .orderBy(...orderOf(name))
  return rows as RegistryRowOf<N>[]
}

/**
 * One registry row by id, whatever its archival state. This is the read that renders a
 * stored reference — the stage a posting is in, the route a lead came through, a label
 * beside an id — and a row archived after it was referenced still has to render, so the
 * archival state is reported on the row rather than deciding whether there is one. The
 * correct read is therefore the default, with no flag for a caller to remember; it is
 * `listRegistry` that hides archived rows, because that is the pick-list a write chooses
 * from. An id with no row is a `NotFoundError`.
 */
export async function findRegistryRow<N extends RegistryName>(
  db: Db,
  name: N,
  id: number,
): Promise<RegistryRowOf<N>> {
  const table = tableFor(name)
  const [found] = await db.select().from(table).where(eq(table.id, id))
  if (!found) throw new NotFoundError(name, id)
  return found as RegistryRowOf<N>
}

/**
 * Refuses a write that names a registry row it may not name: the guard every repository
 * calls before storing a reference to a vocabulary row. An archived row and an id that was
 * never there are separate errors because they are separate answers — the row exists and
 * may not be used, against the row does not exist — which `statusFor` sends as 409 and 404.
 */
export async function assertNotArchived(db: Db, name: RegistryName, id: number): Promise<void> {
  const table = tableFor(name)
  const [found] = await db
    .select({ archivedAt: table.archivedAt })
    .from(table)
    .where(eq(table.id, id))
  if (!found) throw new NotFoundError(name, id)
  if (found.archivedAt !== null) throw new ArchivedError(name, id)
}

/**
 * Checks the references the given rows carry before any of them is written, so a stage
 * naming an archived phase is refused with nothing left behind. The check and the insert
 * are separate statements; a caller that needs them atomic with its own writes passes a
 * transaction as `db`, which is what `Db` accepts one for.
 */
async function assertReferencesUsable(
  db: Db,
  name: RegistryName,
  rows: readonly Readonly<Record<string, unknown>>[],
): Promise<void> {
  const references = REGISTRY_REFERENCES[name]
  if (!references) return
  for (const row of rows) {
    for (const [column, target] of Object.entries(references)) {
      const id = row[column]
      if (typeof id === 'number') await assertNotArchived(db, target, id)
    }
  }
}

/**
 * Adds rows to one registry and returns them as stored. The rows have already been
 * validated against that registry's schema by the surface, which is why this takes the
 * schema's own input type and does not parse again.
 *
 * A key the registry already holds becomes a `ConflictError`, which the surfaces send as
 * 409: it is something the caller can fix in one edit, and left unmapped the driver's
 * fault would fall through `statusFor` as an internal error, carrying the whole failed
 * query in its message. Every other failure is rethrown unchanged.
 */
export async function addRegistryRows<N extends RegistryName>(
  db: Db,
  name: N,
  rows: readonly RegistryRowInputOf<N>[],
): Promise<RegistryRowOf<N>[]> {
  if (rows.length === 0) return []
  const given = rows as readonly Readonly<Record<string, unknown>>[]
  await assertReferencesUsable(db, name, given)
  try {
    const created = await db
      .insert(tableFor(name))
      .values([...rows] as QueryTableInsert[])
      .returning()
    return created as RegistryRowOf<N>[]
  } catch (error) {
    const collided = uniqueColumnsOf(name).find((column) => isUniqueViolation(error, column.constraint))
    if (collided) {
      throw new ConflictError(`${name} ${collided.property}`, conflictingKeys(given, collided.property), {
        cause: error,
      })
    }
    throw error
  }
}

/**
 * Retires a registry row: it stops being offered for new writes and keeps its label, so
 * every row that already named it still renders. Archiving a row that is already archived
 * reports the archival it already had and writes nothing, so a repeated call is a no-op
 * rather than an error or a moved timestamp.
 */
export async function archiveRegistryRow<N extends RegistryName>(
  db: Db,
  name: N,
  id: number,
): Promise<RegistryRowOf<N>> {
  const table = tableFor(name)
  const [archived] = await db
    .update(table)
    .set({ archivedAt: new Date() })
    .where(and(eq(table.id, id), isNull(table.archivedAt)))
    .returning()
  if (archived) return archived as RegistryRowOf<N>

  // Nothing was updated, so the row is either already archived or was never there, and
  // the read that tells those apart is the one that returns an archived row as it is.
  return findRegistryRow(db, name, id)
}
