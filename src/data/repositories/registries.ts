import { and, eq, isNull, type InferInsertModel, type InferSelectModel } from 'drizzle-orm'
import type { PgColumn } from 'drizzle-orm/pg-core'

import { ArchivedError, NotFoundError } from '../../errors.ts'
import type { RegistryRowInputOf, RegistrySchemaName } from '../../schemas/registries.ts'
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
 * registry — the three shared columns and nothing else — and each result is cast back to
 * the named registry's own row type. Four casts is the price: the table going in, the
 * values going in, and the rows coming out of each statement. None of it reaches a caller,
 * who gets `RegistryRowOf<N>` with that registry's own columns.
 */
type QueryTable = (typeof REGISTRY_TABLES)['route']

/** The insert shape of that narrowest table; a wider registry's own columns ride along. */
type QueryTableInsert = InferInsertModel<QueryTable>

function tableFor(name: RegistryName): QueryTable {
  return REGISTRY_TABLES[name] as QueryTable
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
 */
export async function addRegistryRows<N extends RegistryName>(
  db: Db,
  name: N,
  rows: readonly RegistryRowInputOf<N>[],
): Promise<RegistryRowOf<N>[]> {
  if (rows.length === 0) return []
  await assertReferencesUsable(db, name, rows as readonly Readonly<Record<string, unknown>>[])
  const created = await db
    .insert(tableFor(name))
    .values([...rows] as QueryTableInsert[])
    .returning()
  return created as RegistryRowOf<N>[]
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

  // Nothing was updated, so the row is either already archived or was never there.
  const [existing] = await db.select().from(table).where(eq(table.id, id))
  if (!existing) throw new NotFoundError(name, id)
  return existing as RegistryRowOf<N>
}
