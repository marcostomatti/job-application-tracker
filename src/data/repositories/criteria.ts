import { asc, desc, eq, inArray, isNull, max, type InferSelectModel, type SQL } from 'drizzle-orm'

import { ArchivedError, NotFoundError } from '../../errors.ts'
import type { RequirementPatch } from '../../schemas/criteria.ts'
import { criteriaSet, detour, insertCriteriaSet, requirement } from '../schema/criteria.ts'
import { layer } from '../schema/registries.ts'
import type { Db } from './db.ts'
import { pickDefined } from './pick-defined.ts'

export type CriteriaSetRow = InferSelectModel<typeof criteriaSet>
export type DetourRow = InferSelectModel<typeof detour>

/**
 * A requirement as the settings screen and the scorer read it: the stored row, the label of
 * its layer, and the detours that can stand in for it. `layerLabel` is read whatever the
 * layer's archival state, so a layer archived after the requirement was stored still renders,
 * and it is null only when the requirement names no layer. `anchors` is jsonb, so it is
 * `unknown` here: `RequirementAnchorsSchema` narrows it for a caller that needs the shape.
 */
export type RequirementRow = InferSelectModel<typeof requirement> & {
  readonly layerLabel: string | null
  readonly detours: readonly DetourRow[]
}

/** Archived sets are hidden unless asked for, the same default every list in this layer has. */
export type ListCriteriaSetsOptions = { readonly includeArchived?: boolean }

/**
 * The columns of a requirement a caller may change, in one place. A patch copies exactly
 * these keys, so a wider object that carries `id`, `key` or `criteriaSetId` at runtime
 * cannot move a requirement to another set or rename its key.
 */
const EDITABLE_COLUMNS = ['weight', 'kind', 'label', 'anchors'] as const satisfies readonly (keyof RequirementPatch)[]

/** Newest first; sets created in one transaction share a timestamp, so the id breaks the tie. */
export async function listCriteriaSets(db: Db, opts: ListCriteriaSetsOptions = {}): Promise<CriteriaSetRow[]> {
  return db
    .select()
    .from(criteriaSet)
    .where(opts.includeArchived ? undefined : isNull(criteriaSet.archivedAt))
    .orderBy(desc(criteriaSet.createdAt), desc(criteriaSet.id))
}

async function findSet(db: Db, id: number): Promise<CriteriaSetRow> {
  const [found] = await db.select().from(criteriaSet).where(eq(criteriaSet.id, id))
  if (!found) throw new NotFoundError('criteria set', id)
  return found
}

/** The requirements a condition selects, in rubric order, each with its layer label and detours. */
async function readRequirementRows(db: Db, condition: SQL): Promise<RequirementRow[]> {
  const rows = await db
    .select({ requirement, layerLabel: layer.label })
    .from(requirement)
    .leftJoin(layer, eq(layer.id, requirement.layerId))
    .where(condition)
    .orderBy(asc(requirement.sort), asc(requirement.id))
  if (rows.length === 0) return []
  const detours = await db
    .select()
    .from(detour)
    .where(inArray(detour.requirementId, rows.map((row) => row.requirement.id)))
    .orderBy(asc(detour.id))
  return rows.map((row) => ({
    ...row.requirement,
    layerLabel: row.layerLabel,
    detours: detours.filter((entry) => entry.requirementId === row.requirement.id),
  }))
}

/**
 * The requirements of a set in rubric order, with the layer label and the detours of each.
 * A set with none returns an empty list; a set that does not exist is `NotFoundError`, so
 * "nothing in it yet" and "no such set" stay different answers.
 */
export async function getRequirements(db: Db, criteriaSetId: number): Promise<RequirementRow[]> {
  await findSet(db, criteriaSetId)
  return readRequirementRows(db, eq(requirement.criteriaSetId, criteriaSetId))
}

/** Copies one set's requirements into another and returns which new row stands for which old one. */
async function copyRequirements(db: Db, fromSetId: number, toSetId: number): Promise<Map<number, number>> {
  const source = await db
    .select()
    .from(requirement)
    .where(eq(requirement.criteriaSetId, fromSetId))
    .orderBy(asc(requirement.sort), asc(requirement.id))
  if (source.length === 0) return new Map()
  const created = await db
    .insert(requirement)
    .values(
      source.map((row) => ({
        criteriaSetId: toSetId,
        layerId: row.layerId,
        key: row.key,
        label: row.label,
        kind: row.kind,
        weight: row.weight,
        anchors: row.anchors,
        sort: row.sort,
      })),
    )
    .returning({ id: requirement.id, key: requirement.key })
  const newIdByKey = new Map(created.map((row) => [row.key, row.id]))
  return new Map(source.flatMap((row) => {
    const newId = newIdByKey.get(row.key)
    return newId === undefined ? [] : [[row.id, newId] as const]
  }))
}

/** Gives each copied requirement its own copy of the detours of the one it was copied from. */
async function copyDetours(db: Db, newIdByOldId: ReadonlyMap<number, number>): Promise<void> {
  if (newIdByOldId.size === 0) return
  const source = await db
    .select()
    .from(detour)
    .where(inArray(detour.requirementId, [...newIdByOldId.keys()]))
    .orderBy(asc(detour.id))
  const copies = source.flatMap((row) => {
    const requirementId = newIdByOldId.get(row.requirementId)
    if (requirementId === undefined) return []
    return [{ requirementId, label: row.label, discount: row.discount, costAmount: row.costAmount, costUnit: row.costUnit }]
  })
  if (copies.length > 0) await db.insert(detour).values(copies)
}

/** The next free version number under a name: one past the highest that exists, archived ones included. */
async function nextVersionFor(db: Db, name: string): Promise<number> {
  const [highest] = await db.select({ version: max(criteriaSet.version) }).from(criteriaSet).where(eq(criteriaSet.name, name))
  return (highest?.version ?? 0) + 1
}

/**
 * Makes a new version of a criteria set: a new set under the same name (or `input.name`),
 * numbered one past the highest version that name already has, with the source's
 * requirements, anchors, detours, weights and apply threshold copied in. The number is a
 * sequence and not a lineage marker (the table records no parent), so copying v1 while v2
 * exists gives v3 carrying v1's content. The weights and the threshold are copied on
 * purpose: a new version of the user's own criteria is a starting point to adjust, and a
 * blank form to refill would throw their judgement away; it is a vanilla pack that ships
 * without any.
 *
 * The copy is never the default (choosing one is `setDefaultCriteriaSet`'s job) and is never
 * archived, whatever the source was. Everything is written in one transaction, so a failed
 * copy leaves no half-built version. The set rows are locked first, so two callers cannot
 * read the same highest version and claim the same number; the `(name, version)` unique
 * constraint stays as the backstop and surfaces as `CriteriaSetConflictError`.
 */
export async function createCriteriaVersion(
  db: Db,
  input: { readonly fromSetId: number; readonly name?: string },
): Promise<CriteriaSetRow> {
  return db.transaction(async (tx) => {
    await lockEverySet(tx)
    const source = await findSet(tx, input.fromSetId)
    const name = input.name ?? source.name
    const created = await insertCriteriaSet(tx, {
      name,
      version: await nextVersionFor(tx, name),
      applyThreshold: source.applyThreshold,
      isDefault: false,
    })
    const newIdByOldId = await copyRequirements(tx, source.id, created.id)
    await copyDetours(tx, newIdByOldId)
    return created
  })
}

/**
 * Changes the weight, kind, label or anchors of a requirement and returns it as stored, with
 * its layer label and detours. Only those four columns are written, whatever else the patch
 * object carries. An empty patch writes nothing and returns the row, because an empty
 * `SET` is a statement Postgres refuses and the caller asked for no change.
 */
export async function updateRequirement(
  db: Db,
  id: number,
  patch: RequirementPatch,
): Promise<RequirementRow> {
  const changes = pickDefined(patch, EDITABLE_COLUMNS)
  if (Object.keys(changes).length > 0) {
    const [updated] = await db.update(requirement).set(changes).where(eq(requirement.id, id)).returning({ id: requirement.id })
    if (!updated) throw new NotFoundError('requirement', id)
  }
  const [row] = await readRequirementRows(db, eq(requirement.id, id))
  if (!row) throw new NotFoundError('requirement', id)
  return row
}

/**
 * Holds a row lock on every criteria set until the transaction ends. The default slot is a
 * partial unique index, so two callers moving it at once would each clear, then each set, and
 * the second set would fail against the index with a raw driver error. With the locks the
 * second caller waits for the first to commit, then clears the first caller's choice.
 * `createCriteriaVersion` takes the same locks, so it can number a version without a race.
 *
 * The lock is `FOR NO KEY UPDATE`, not `FOR UPDATE`: nothing here changes a key, and `FOR
 * UPDATE` would block every concurrent insert that references `criteria_set` (a requirement,
 * a score), because such an insert takes `FOR KEY SHARE` on the row it points at. This lock
 * still excludes other callers of itself, which is all it is for. The
 * table holds one row per version of the user's own criteria, so locking all of it is cheap,
 * and the rows are taken in id order so two callers cannot wait on each other.
 */
async function lockEverySet(db: Db): Promise<void> {
  await db.select({ id: criteriaSet.id }).from(criteriaSet).orderBy(asc(criteriaSet.id)).for('no key update')
}

/**
 * Makes a set the one default. The previous default is cleared first, in the same
 * transaction, because `criteria_set_single_default` admits one row and would refuse the
 * second `UPDATE` otherwise. An archived set cannot be the default (`ArchivedError`), and the
 * check runs before anything is cleared, so a refused call leaves the current default in place.
 */
export async function setDefaultCriteriaSet(db: Db, id: number): Promise<void> {
  await db.transaction(async (tx) => {
    await lockEverySet(tx)
    const target = await findSet(tx, id)
    if (target.archivedAt !== null) throw new ArchivedError('criteria set', id)
    await tx.update(criteriaSet).set({ isDefault: false }).where(eq(criteriaSet.isDefault, true))
    await tx.update(criteriaSet).set({ isDefault: true }).where(eq(criteriaSet.id, id))
  })
}
