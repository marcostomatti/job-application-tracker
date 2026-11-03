import { and, asc, desc, eq, isNull, sql, type InferSelectModel } from 'drizzle-orm'

import { NotFoundError } from '../../errors.ts'
import { PAGE_LIMIT_MAX } from '../../schemas/common.ts'
import type { RecordRejectionInput, SetAsideInput, StageEventInput } from '../../schemas/dispositions.ts'
import { positionDisposition, positionStageEvent } from '../schema/dispositions.ts'
import { position } from '../schema/positions.ts'
import { phase as phaseTable, setAsideReason, stage as stageTable } from '../schema/registries.ts'
import type { Db } from './db.ts'
import { pickDefined } from './pick-defined.ts'
import { SET_ASIDE_KIND, searchPositions, type PositionListRow } from './positions.ts'
import { assertNotArchived, type RegistryRowOf } from './registries.ts'

export type StageEvent = InferSelectModel<typeof positionStageEvent>
export type Disposition = InferSelectModel<typeof positionDisposition>

/** The latest stage event of a position, with the stage it names and that stage's flags. */
export type StageRow = {
  readonly event: StageEvent
  readonly stage: RegistryRowOf<'stage'>
}

/** The positions set aside for one reason, which is §11.1 group 7's "grouped by why". */
export type SetAsideGroup = {
  readonly reasonId: number
  readonly reasonLabel: string
  readonly positions: readonly PositionListRow[]
}

/**
 * The internal discriminator of a disposition that records the other side's rejection. `kind`
 * is the one column the table's CHECK lists and the code branches on, so naming its values is
 * not the user's vocabulary. The set-aside value is shared with the position search, which
 * counts it, and is imported from there so the two cannot drift.
 */
const REJECTED_KIND = 'rejected'

/**
 * The optional columns each write copies from its input, one list per write, so a key outside
 * the list cannot reach the table even when the object a caller passes carries it. The
 * required columns are named where the row is built, and `kind` is set by the function that
 * owns it: each disposition names its own reason column and never the other.
 */
const STAGE_EVENT_OPTIONAL_COLUMNS = ['note'] as const satisfies readonly (keyof StageEventInput)[]
const DISPOSITION_OPTIONAL_COLUMNS = ['note'] as const satisfies readonly (keyof SetAsideInput & keyof RecordRejectionInput)[]

async function assertPositionExists(db: Db, positionId: number): Promise<void> {
  const [found] = await db.select({ id: position.id }).from(position).where(eq(position.id, positionId))
  if (!found) throw new NotFoundError('position', positionId)
}

/**
 * Takes the position's row so that two writers about one position's stage run one after the
 * other, and reports a position that is not there. A foreign key alone would not do it: the
 * share lock an inserted event takes on its position does not conflict with another writer's
 * share lock, so a re-score reading "not applied" could file a shortlist event after the user
 * had filed an application. `no key update` is the weakest lock that still conflicts with
 * itself, and leaves the insert's own key check alone. It lasts until the enclosing
 * transaction ends, so callers hold it inside `db.transaction`.
 */
async function lockPosition(db: Db, positionId: number): Promise<void> {
  const [found] = await db
    .select({ id: position.id })
    .from(position)
    .where(eq(position.id, positionId))
    .for('no key update')
  if (!found) throw new NotFoundError('position', positionId)
}

/**
 * Writes the event, dated by the caller or else by the wall clock at this statement. The
 * column's own default is `now()`, which is the instant the transaction began, and both
 * writers take the position's lock after that: a transaction that began early but won the
 * lock late would be dated before the one it follows, and the events would read in the
 * opposite order from the one the lock established. `clock_timestamp()` runs when the insert
 * does, after any lock wait, so the dates follow the serialisation.
 */
async function insertStageEvent(db: Db, input: StageEventInput): Promise<StageEvent> {
  const [written] = await db
    .insert(positionStageEvent)
    .values({
      positionId: input.positionId,
      stageId: input.stageId,
      occurredAt: input.occurredAt ?? sql`clock_timestamp()`,
      ...pickDefined(input, STAGE_EVENT_OPTIONAL_COLUMNS),
    })
    .returning()
  if (!written) throw new Error('The stage event insert returned no row.')
  return written
}

/**
 * Records that a position moved to a stage, or, with a null stage, that it moved somewhere the
 * user has not named yet (the stage registry ships empty). It is the only writer of
 * `position_stage_event`, and this module exports no update and no delete: the table is
 * append-only by the shape of this API, because the migration lint forbids the routines a
 * trigger would need. The current stage is read from the latest event, never stored.
 *
 * A stage that was archived, or never existed, is refused (`ArchivedError`, `NotFoundError`),
 * as is a missing position. Nothing stops a stage being recorded twice, and that is deliberate:
 * `is_repeatable` is a reading hint, not a write constraint. It tells a consumer that the
 * stage occurs once per round, and the counting of those rounds ("this process had four
 * steps") is done by whoever reads the rows. The history is append-only, so refusing a
 * second record of a stage the user marked non-repeatable would lose something that did
 * happen, which is worse than an advisory flag.
 */
export async function appendStageEvent(db: Db, input: StageEventInput): Promise<StageEvent> {
  return db.transaction(async (tx) => {
    await lockPosition(tx, input.positionId)
    if (input.stageId !== null) await assertNotArchived(tx, 'stage', input.stageId)
    return insertStageEvent(tx, input)
  })
}

/** The latest event by time, then by id, with its stage when it names one. The stage is joined without an archival filter. */
async function readLatestEvent(
  db: Db,
  positionId: number,
): Promise<{ readonly event: StageEvent; readonly stage: RegistryRowOf<'stage'> | null } | null> {
  const [latest] = await db
    .select({ event: positionStageEvent, stage: stageTable })
    .from(positionStageEvent)
    .leftJoin(stageTable, eq(stageTable.id, positionStageEvent.stageId))
    .where(eq(positionStageEvent.positionId, positionId))
    .orderBy(desc(positionStageEvent.occurredAt), desc(positionStageEvent.id))
    .limit(1)
  return latest ?? null
}

/**
 * Where the position is now: its latest event by `(occurredAt, id)`, with that stage's flags.
 * Null when the position has no event, and also when the latest event names no stage, which
 * is a normal state before the user has built a stage registry. A stage archived after the
 * event was recorded is still returned, so its label still renders. A position that does not
 * exist is `NotFoundError`, so "no such position" and "no stage yet" stay different answers.
 */
export async function currentStage(db: Db, positionId: number): Promise<StageRow | null> {
  await assertPositionExists(db, positionId)
  const latest = await readLatestEvent(db, positionId)
  return latest?.stage ? { event: latest.event, stage: latest.stage } : null
}

/**
 * Whether the position has been applied to: true only when its latest event names a stage
 * the user flagged `is_applied`. A null stage is not applied, and neither is an unflagged
 * one, because the stage registry ships empty and a fresh install must not read every
 * position as committed, which would silently stop `moveIfRecommended` from ever firing.
 * A position that does not exist is `NotFoundError`: `false` would be an affirmative answer
 * about nothing.
 */
export async function isApplied(db: Db, positionId: number): Promise<boolean> {
  await assertPositionExists(db, positionId)
  return isAppliedAt(db, positionId)
}

/** The applied check without the existence read, for a caller that already holds the position's row. */
async function isAppliedAt(db: Db, positionId: number): Promise<boolean> {
  const latest = await readLatestEvent(db, positionId)
  return latest?.stage?.isApplied === true
}

/**
 * The stage a recommended position lands in: the lowest-`sort` stage that is not terminal, in
 * the phase flagged `is_shortlist`. Found by the flags and `sort` alone, never by a key or
 * a label. Archived phases and stages are not offered, as for any new reference. Should the
 * user flag more than one phase, the lowest-sorted phase wins, and equal sorts fall to the
 * lowest id, so the answer never depends on the order storage returns rows in.
 */
async function findShortlistStageId(db: Db): Promise<number | null> {
  const [found] = await db
    .select({ id: stageTable.id })
    .from(stageTable)
    .innerJoin(phaseTable, eq(phaseTable.id, stageTable.phaseId))
    .where(
      and(
        eq(phaseTable.isShortlist, true),
        isNull(phaseTable.archivedAt),
        isNull(stageTable.archivedAt),
        eq(stageTable.isTerminal, false),
      ),
    )
    .orderBy(asc(phaseTable.sort), asc(phaseTable.id), asc(stageTable.sort), asc(stageTable.id))
    .limit(1)
  return found?.id ?? null
}

/**
 * §9.1's move rule: when a score recommends applying and the position is not already
 * applied, file it in the shortlist stage and return the event; otherwise return null and
 * write nothing. It returns null, and does not throw, when no phase is flagged `is_shortlist`
 * or that phase holds no usable stage: the registries ship empty, and a re-score must not
 * fail because the user has not built their vocabulary yet.
 *
 * The check and the write run under the position's row lock, so an application filed by
 * another transaction between them cannot be moved back to the shortlist.
 *
 * With `recommendApply` false it returns null without reading the position, so an unknown
 * position is reported only when the call would have moved it. That is not an inconsistency
 * with `currentStage` and `isApplied`, which raise for a missing position: here the null is
 * an answer about the input (there is nothing to do, whatever state the position is in), not a
 * claim about the position, so it need not verify the row and does not pay a read to do so.
 */
export async function moveIfRecommended(
  db: Db,
  input: { readonly positionId: number; readonly recommendApply: boolean },
): Promise<StageEvent | null> {
  if (!input.recommendApply) return null
  return db.transaction(async (tx) => {
    await lockPosition(tx, input.positionId)
    if (await isAppliedAt(tx, input.positionId)) return null
    const stageId = await findShortlistStageId(tx)
    return stageId === null ? null : insertStageEvent(tx, { positionId: input.positionId, stageId })
  })
}

async function insertDisposition(db: Db, values: typeof positionDisposition.$inferInsert): Promise<Disposition> {
  const [written] = await db.insert(positionDisposition).values(values).returning()
  if (!written) throw new Error('The disposition insert returned no row.')
  return written
}

/**
 * The user passing on a lead, for a reason of their own from the set-aside registry. The
 * position's stage is not touched: the two are separate axes. An archived or unknown reason,
 * or a missing position, is refused before anything is written. The reason is required by
 * the type, and a caller that bypasses the type and sends none gets a `NotFoundError` from
 * the registry check rather than the database's CHECK failing with a message that repeats
 * the statement.
 */
export async function setAside(db: Db, input: SetAsideInput): Promise<Disposition> {
  await assertPositionExists(db, input.positionId)
  await assertNotArchived(db, 'set_aside_reason', input.setAsideReasonId)
  return insertDisposition(db, {
    kind: SET_ASIDE_KIND,
    positionId: input.positionId,
    setAsideReasonId: input.setAsideReasonId,
    ...pickDefined(input, DISPOSITION_OPTIONAL_COLUMNS),
  })
}

/**
 * What the other side did: a rejection with a reason from the rejection registry, which is
 * kept apart from the set-aside one because it describes the market's behaviour and not the
 * user's criteria. Two functions rather than one taking a `kind`, so the wrong reason for a
 * kind cannot be written in TypeScript; the table's CHECK is the guarantee behind that.
 */
export async function recordRejection(db: Db, input: RecordRejectionInput): Promise<Disposition> {
  await assertPositionExists(db, input.positionId)
  await assertNotArchived(db, 'rejection_reason', input.rejectionReasonId)
  return insertDisposition(db, {
    kind: REJECTED_KIND,
    positionId: input.positionId,
    rejectionReasonId: input.rejectionReasonId,
    ...pickDefined(input, DISPOSITION_OPTIONAL_COLUMNS),
  })
}

/** Every position with a set-aside disposition, as the board draws it, read a page at a time. */
async function readSetAsidePositions(db: Db): Promise<PositionListRow[]> {
  const rows: PositionListRow[] = []
  for (let offset = 0; ; offset += PAGE_LIMIT_MAX) {
    const page = await searchPositions(db, { limit: PAGE_LIMIT_MAX, offset, setAside: 'only', clientHidden: 'include' })
    rows.push(...page)
    if (page.length < PAGE_LIMIT_MAX) return rows
  }
}

export type SetAsideReasonOf = { readonly reasonId: number; readonly reasonLabel: string }

/**
 * The reason each position was most recently set aside for, by position id: dispositions
 * are read oldest first and a later one replaces an earlier one. The label is joined without
 * an archival filter, so a reason archived after use still names its group.
 */
async function readLatestSetAsideReasons(db: Db): Promise<Map<number, SetAsideReasonOf>> {
  const rows = await db
    .select({
      positionId: positionDisposition.positionId,
      reasonId: setAsideReason.id,
      reasonLabel: setAsideReason.label,
    })
    .from(positionDisposition)
    .innerJoin(setAsideReason, eq(setAsideReason.id, positionDisposition.setAsideReasonId))
    .where(eq(positionDisposition.kind, SET_ASIDE_KIND))
    .orderBy(asc(positionDisposition.notedAt), asc(positionDisposition.id))
  return new Map(rows.map((row) => [row.positionId, { reasonId: row.reasonId, reasonLabel: row.reasonLabel }]))
}

/**
 * Groups rows under the reason each position was last set aside for. A position appears once
 * in its group even if `rows` lists it twice: the rows come from offset paging, which is not
 * a snapshot, so a position touched between two pages can be read on both, and the same role
 * twice in one list would be wrong where skipping one under a concurrent write is not. A row
 * with no reason, which cannot happen for a row that is set aside, is left out.
 */
export function groupBySetAsideReason(
  rows: readonly PositionListRow[],
  reasons: ReadonlyMap<number, SetAsideReasonOf>,
): SetAsideGroup[] {
  const seen = new Set<number>()
  const groups = new Map<number, { reasonLabel: string; positions: PositionListRow[] }>()
  for (const row of rows) {
    const reason = reasons.get(row.position.id)
    if (reason === undefined || seen.has(row.position.id)) continue
    seen.add(row.position.id)
    const group = groups.get(reason.reasonId) ?? { reasonLabel: reason.reasonLabel, positions: [] }
    groups.set(reason.reasonId, { ...group, positions: [...group.positions, row] })
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left - right)
    .map(([reasonId, group]) => ({ reasonId, ...group }))
}

/**
 * The set-aside positions grouped by why (§11.1 group 7). A position is in the group of its
 * latest set-aside reason, once. A later rejection does not remove it: the grouping exists so
 * the user can see why they passed on leads and refine a gate or a weight from it, and their
 * judgement happened whatever the other side did afterwards. A position that was only
 * rejected has no set-aside and is not listed. The positions are read through
 * `searchPositions`, a page at a time with no cap, so the filter and the archival-safe reads
 * are the board's own rather than a second query that could drift from them.
 * Client-hidden positions are included, since the user set these aside themselves. Groups
 * come in registry order (reason id) and positions in the board's order, newest seen first.
 * Empty when nothing was set aside.
 *
 * The positions are read first and the reasons after, so every position read has its
 * set-aside by the time the reasons are: dispositions are only ever appended.
 */
export async function listSetAside(db: Db): Promise<SetAsideGroup[]> {
  const rows = await readSetAsidePositions(db)
  return groupBySetAsideReason(rows, await readLatestSetAsideReasons(db))
}
