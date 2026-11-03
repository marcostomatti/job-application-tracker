import { and, asc, countDistinct, desc, eq, isNotNull, isNull, or, type InferSelectModel } from 'drizzle-orm'

import { ConflictError, NotFoundError } from '../../errors.ts'
import type { Origin } from '../../entities/provenance.ts'
import type { OriginInput, SearchRunInput } from '../../schemas/provenance.ts'
import { isForeignKeyViolation } from '../driver-faults.ts'
import { position } from '../schema/positions.ts'
import { origin, positionFirstTouch, searchRun } from '../schema/provenance.ts'
import { route } from '../schema/registries.ts'
import type { Db } from './db.ts'
import { pickDefined } from './pick-defined.ts'
import { assertNotArchived } from './registries.ts'

export type SearchRun = InferSelectModel<typeof searchRun>

/** How many positions each route reached; `routeId` and `routeLabel` are null for touches that named no route. */
export type RouteCount = {
  readonly routeId: number | null
  readonly routeLabel: string | null
  readonly positions: number
}

/**
 * The optional columns of an origin a caller may set, in one list: an object that carries
 * more than the type says (`id`, `recordedAt`) cannot write a column this list does not name.
 * `touchedOn` is required and is named where the row is built.
 */
const ORIGIN_OPTIONAL_COLUMNS = ['positionId', 'routeId', 'note', 'searchRunId'] as const satisfies readonly (keyof OriginInput)[]

/**
 * The foreign keys of `origin` that name a row some other write owns, with what each one
 * reports when it refuses. The key is the guarantee that the row exists, so a write does not
 * read first and race the delete; it only types the fault the database raised.
 */
type ReferenceKey = { readonly constraint: string; readonly entity: string }
const POSITION_KEY: ReferenceKey = { constraint: 'origin_position_id_position_id_fk', entity: 'position' }
const SEARCH_RUN_KEY: ReferenceKey = { constraint: 'origin_search_run_id_search_run_id_fk', entity: 'search run' }

/**
 * The `NotFoundError` for the row a foreign-key fault says is missing, or null when it is
 * another fault. Only a reference the call actually named can be the one that failed.
 */
function missingRow(
  error: unknown,
  named: readonly (readonly [ReferenceKey, number | null | undefined])[],
): NotFoundError | null {
  for (const [key, id] of named) {
    if (id != null && isForeignKeyViolation(error, key.constraint)) {
      return new NotFoundError(key.entity, id, { cause: error })
    }
  }
  return null
}

/** Reports a position that is not there, so "no such position" and "no origins yet" stay different answers. */
async function assertPositionExists(db: Db, positionId: number): Promise<void> {
  const [found] = await db.select({ id: position.id }).from(position).where(eq(position.id, positionId))
  if (!found) throw new NotFoundError('position', positionId)
}

/**
 * Logs one touch: a dated way a lead reached the user. It may name no position, because a
 * conversation at a meetup is a first touch before any posting exists (`attachOrigin` ties it
 * to one later), and no route, because the route registry ships empty. `touchedOn` is stored as
 * typed, a future date included: a mistyped year stays readable and is only ignored when first
 * touch is derived. An archived or unknown route is refused (`ArchivedError`, `NotFoundError`),
 * and so is a missing position or search run, by the foreign keys.
 */
export async function recordOrigin(db: Db, input: OriginInput): Promise<Origin> {
  if (input.routeId != null) await assertNotArchived(db, 'route', input.routeId)
  try {
    const [written] = await db
      .insert(origin)
      .values({ touchedOn: input.touchedOn, ...pickDefined(input, ORIGIN_OPTIONAL_COLUMNS) })
      .returning()
    if (!written) throw new Error('The origin insert returned no row.')
    return written
  } catch (error) {
    throw missingRow(error, [[POSITION_KEY, input.positionId], [SEARCH_RUN_KEY, input.searchRunId]]) ?? error
  }
}

/**
 * Ties a touch logged before its posting existed to that posting. It changes nothing but
 * `position_id`, so the touch keeps its own date and first touch stays derived: attaching a
 * backdated conversation makes it win without any other row being edited. An origin that is
 * already on this position is returned as it is, so repeating the call is harmless. One on
 * another position is a `ConflictError`, because moving a touch would rewrite how the lead
 * was reached; a missing origin or position is `NotFoundError`. The guard is part of the
 * `UPDATE`, so two callers attaching one origin cannot both succeed.
 */
export async function attachOrigin(db: Db, originId: number, positionId: number): Promise<Origin> {
  try {
    const [attached] = await db
      .update(origin)
      .set({ positionId })
      .where(and(eq(origin.id, originId), or(isNull(origin.positionId), eq(origin.positionId, positionId))))
      .returning()
    if (attached) return attached
  } catch (error) {
    throw missingRow(error, [[POSITION_KEY, positionId]]) ?? error
  }
  const [existing] = await db.select({ id: origin.id }).from(origin).where(eq(origin.id, originId))
  if (!existing) throw new NotFoundError('origin', originId)
  throw new ConflictError('origin', String(originId), {
    message: `origin ${originId} is already attached to another position`,
  })
}

/**
 * Every origin of a position, in the order first touch ranks them: `touched_on`, then
 * `recorded_at`, then `id`. Future-dated rows are listed, since they are stored; only first
 * touch skips them. A position that does not exist is `NotFoundError`.
 */
export async function listOrigins(db: Db, positionId: number): Promise<Origin[]> {
  await assertPositionExists(db, positionId)
  return db
    .select()
    .from(origin)
    .where(eq(origin.positionId, positionId))
    .orderBy(asc(origin.touchedOn), asc(origin.recordedAt), asc(origin.id))
}

/**
 * The origin that first reached a position, read from the `position_first_touch` view and
 * joined back to the full row, which the view does not carry. Null when the position has no
 * origin dated today or earlier. The view and `firstTouch` apply one rule, and a test pins
 * that they agree, so this is a reading of that rule and not a second statement of it. A
 * position that does not exist is `NotFoundError`.
 */
export async function getFirstTouch(db: Db, positionId: number): Promise<Origin | null> {
  await assertPositionExists(db, positionId)
  const [first] = await db
    .select({ origin })
    .from(positionFirstTouch)
    .innerJoin(origin, eq(origin.id, positionFirstTouch.originId))
    .where(eq(positionFirstTouch.positionId, positionId))
  return first?.origin ?? null
}

/** Records one machine query: what was asked and where. The database stamps when it ran. */
export async function recordSearchRun(db: Db, input: SearchRunInput): Promise<SearchRun> {
  const [written] = await db.insert(searchRun).values({ query: input.query, source: input.source }).returning()
  if (!written) throw new Error('The search run insert returned no row.')
  return written
}

/**
 * How many positions each route reached. A position is counted once under every route it was
 * reached through, so one reached by a board and by a friend is in both rows, and one reached
 * by the same board twice is in that row once. The column therefore does not sum to the number
 * of positions: it answers "how many positions did each route bring me", which is not "how many
 * positions are there". Touches with no route form a row with a null
 * route, and touches with no position are left out, since they have reached nothing yet. Every
 * touch counts whatever its date: a mistyped day does not change which door it was. The label
 * is joined without an archival filter, so a route archived after positions came through it
 * still names its row. Busiest route first, then registry order.
 */
export async function routeCounts(db: Db): Promise<RouteCount[]> {
  const reached = countDistinct(origin.positionId)
  return db
    .select({ routeId: origin.routeId, routeLabel: route.label, positions: reached })
    .from(origin)
    .leftJoin(route, eq(route.id, origin.routeId))
    .where(isNotNull(origin.positionId))
    .groupBy(origin.routeId, route.label)
    .orderBy(desc(reached), asc(origin.routeId))
}

/**
 * Whether the role came round again: more than one origin on it, whatever the route and
 * date. It is the third of §11.1 group 9's checks; the other two, "did the posting change" and
 * "was it already applied to", are `summaryChanged` and `isApplied` and are not repeated here.
 * A position that does not exist is `NotFoundError`.
 */
export async function wasReposted(db: Db, positionId: number): Promise<boolean> {
  await assertPositionExists(db, positionId)
  const rows = await db.select({ id: origin.id }).from(origin).where(eq(origin.positionId, positionId)).limit(2)
  return rows.length > 1
}
