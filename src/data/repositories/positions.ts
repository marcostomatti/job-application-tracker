import { and, asc, desc, eq, inArray, sql, type InferSelectModel, type SQL } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'

import { BulkItemError, ConflictError, NotFoundError } from '../../errors.ts'
import type { PositionInput, PositionPatch, PositionQuery } from '../../schemas/positions.ts'
import { isUniqueViolation } from '../driver-faults.ts'
import { criteriaSet, requirement } from '../schema/criteria.ts'
import { positionDisposition, positionStageEvent } from '../schema/dispositions.ts'
import { company as companyTable, normaliseName, position } from '../schema/positions.ts'
import { origin } from '../schema/provenance.ts'
import { penaltyKind, phase as phaseTable, rejectionReason, route, setAsideReason, stage as stageTable } from '../schema/registries.ts'
import { positionPenalty, positionRating, positionScore } from '../schema/scores.ts'
import { findCompany, upsertCompany, type Company } from './companies.ts'
import type { Db } from './db.ts'
import { isItemFault } from './item-fault.ts'
import { pickDefined } from './pick-defined.ts'
import { assertNotArchived, findRegistryRow, type RegistryName, type RegistryRowOf } from './registries.ts'
import { findSummary, type PositionSummary } from './summaries.ts'

export type Position = InferSelectModel<typeof position>
type StageEvent = InferSelectModel<typeof positionStageEvent>
type Score = InferSelectModel<typeof positionScore>
type Rating = InferSelectModel<typeof positionRating>
type Penalty = InferSelectModel<typeof positionPenalty>
type Disposition = InferSelectModel<typeof positionDisposition>
type Origin = InferSelectModel<typeof origin>

/**
 * The registry rows a position names, each read whatever its archival state: a row archived
 * after the position was stored must still render, so a label never goes blank because of
 * what happened to the vocabulary later.
 */
export type PositionReferences = {
  readonly workFormat: RegistryRowOf<'work_format'> | null
  readonly seniority: RegistryRowOf<'seniority'> | null
  readonly applyRoute: RegistryRowOf<'apply_route'> | null
}

/** The latest stage event of a position, with the stage it names and that stage's phase. */
export type LatestStage = {
  readonly event: StageEvent
  readonly stage: RegistryRowOf<'stage'> | null
  readonly phase: RegistryRowOf<'phase'> | null
}

export type RatingDetail = {
  readonly rating: Rating
  readonly requirementKey: string
  readonly requirementLabel: string
}

export type PenaltyDetail = { readonly penalty: Penalty; readonly kindLabel: string }

/** One score with the ratings and penalties that make it up. */
export type ScoreDetail = {
  readonly score: Score
  readonly ratings: readonly RatingDetail[]
  readonly penalties: readonly PenaltyDetail[]
}

/** `reasonLabel` is the label of whichever reason the disposition's `kind` carries. */
export type DispositionDetail = { readonly disposition: Disposition; readonly reasonLabel: string | null }

export type OriginDetail = { readonly origin: Origin; readonly routeLabel: string | null }

/** Everything the detail modal shows for one position. */
export type PositionDetail = {
  readonly position: Position
  readonly company: Company
  readonly references: PositionReferences
  readonly summary: PositionSummary | null
  readonly latestStage: LatestStage | null
  readonly scores: readonly ScoreDetail[]
  readonly dispositions: readonly DispositionDetail[]
  readonly origins: readonly OriginDetail[]
}

/**
 * One row of the board and the grid. `stage` and `phase` come from the position's latest
 * stage event; `score` is the latest score under the criteria set the query named, or the
 * default set. `setAside` says whether any disposition of kind `set_aside` exists, so a
 * caller that asked to include set-aside positions can tell which they are.
 */
export type PositionListRow = {
  readonly position: Position
  readonly company: Company
  readonly stage: RegistryRowOf<'stage'> | null
  readonly phase: RegistryRowOf<'phase'> | null
  readonly score: Score | null
  readonly setAside: boolean
}

/** The internal discriminator of a disposition that sets a lead aside. */
export const SET_ASIDE_KIND = 'set_aside'

/** The constraint names in `0002_positions.sql`, which Postgres reports on a duplicate. */
const KEY_CONSTRAINT = 'position_position_key_unique'
const ROLE_CONSTRAINT = 'position_company_role_disambiguator_unique'

/**
 * The columns of a position that name a registry row, and the registry each names. They are
 * data so the archival guard stays a loop: nothing here branches on which registry it is.
 */
const POSITION_REFERENCES = [
  ['workFormatId', 'work_format'],
  ['seniorityId', 'seniority'],
  ['applyRouteId', 'apply_route'],
] as const satisfies readonly (readonly [keyof Position, RegistryName])[]

type ReferencedIds = Partial<Record<(typeof POSITION_REFERENCES)[number][0], number | null>>

/**
 * The columns a caller may set directly, on creation or in a patch: the whole list, in one
 * place. Both writes copy exactly these keys and no others, so a column that is not named
 * here cannot be written by a wider object that merely carries it at runtime (a TypeScript
 * type does not stop an extra property on a variable). The role title, its normalised form,
 * the key and the company are set by the code that owns them, and the three import
 * timestamps are never set from a caller.
 */
const EDITABLE_COLUMNS = [
  'seenAt',
  'deadline',
  'city',
  'country',
  'workFormatId',
  'seniorityId',
  'applyRouteId',
  'salaryRaw',
  'postingAgeRaw',
  'applicantCountRaw',
  'applyContact',
  'clientHidden',
] as const satisfies readonly (keyof Position)[]

/**
 * What a patch may additionally set. `priorityRank` is the user's own hand-ranking: it is
 * listed here, and in no list a creation reads, which is the whole of "no import may write it".
 */
const PATCH_ONLY_COLUMNS = ['disambiguator', 'priorityRank'] as const satisfies readonly (keyof Position)[]

/**
 * Refuses a write that names a registry row it may not name. It runs before the write so an
 * archived or missing row is refused with its own error, and checks only ids the call
 * carries: `null` clears a reference and absent leaves it alone.
 */
async function assertReferencesUsable(db: Db, ids: ReferencedIds): Promise<void> {
  for (const [column, registry] of POSITION_REFERENCES) {
    const id = ids[column]
    if (typeof id === 'number') await assertNotArchived(db, registry, id)
  }
}

/**
 * The key a position gets when the caller names none: employer and role, each in its
 * normalised form, with the disambiguator when there is one. The same role reposted derives
 * the same key, which is what makes a repost one position.
 */
function derivedPositionKey(companyNorm: string, roleNorm: string, disambiguatorText: string): string {
  const key = `${companyNorm}/${roleNorm}`
  return disambiguatorText === '' ? key : `${key}/${disambiguatorText}`
}

/**
 * Turns a duplicate into the `ConflictError` the surfaces send as 409, and leaves every
 * other failure alone. Postgres names the violated constraint and not the row, so `describe`
 * supplies the words for the role and the key is the value the call carried; the driver's
 * own message, which repeats the query, stays on `cause`.
 */
function asConflict(error: unknown, describe: { readonly role: string; readonly key: string }): unknown {
  if (isUniqueViolation(error, KEY_CONSTRAINT)) {
    return new ConflictError('position_key', describe.key, { cause: error })
  }
  if (isUniqueViolation(error, ROLE_CONSTRAINT)) {
    return new ConflictError('position', describe.role, { cause: error })
  }
  return error
}

/** The row to insert for one input, given the company it resolved to. */
function insertValuesOf(input: PositionInput, owner: Company): typeof position.$inferInsert {
  const roleNorm = normaliseName(input.roleTitle)
  const given = input.disambiguator ?? ''
  return {
    ...pickDefined(input, EDITABLE_COLUMNS),
    positionKey: input.positionKey ?? derivedPositionKey(owner.nameNorm, roleNorm, given),
    companyId: owner.id,
    roleTitle: input.roleTitle,
    roleNorm,
    disambiguator: given,
  }
}

async function addOnePosition(db: Db, input: PositionInput): Promise<Position> {
  await assertReferencesUsable(db, input)
  const owner = await upsertCompany(db, input.company)
  const values = insertValuesOf(input, owner)
  try {
    const [created] = await db.insert(position).values(values).returning()
    if (!created) throw new NotFoundError('position', values.positionKey)
    return created
  } catch (error) {
    const suffix = values.disambiguator === '' ? '' : ` (${values.disambiguator})`
    throw asConflict(error, { role: `${values.roleTitle} at ${owner.name}${suffix}`, key: values.positionKey })
  }
}

/**
 * Records positions, all or none. Every item runs inside one transaction, in order, so the
 * first one that cannot be stored stops the call and rolls back everything before it,
 * including the companies those items created, and raises `BulkItemError` carrying that
 * item's index and the reason as its `cause`. This is the bulk-failure contract: nothing is
 * written, and the failing item is named.
 *
 * Only a fault about the item (a duplicate, an archived or unknown vocabulary row) becomes a
 * `BulkItemError`. Anything else, such as a lost connection, is not the item's fault and
 * reaches the caller as it is, so it is not reported as a mistake in the input.
 *
 * Called with a transaction as `db`, the transaction here is a savepoint, so the caller's own
 * writes roll back with it.
 */
export async function addPositions(db: Db, inputs: readonly PositionInput[]): Promise<Position[]> {
  if (inputs.length === 0) return []
  return db.transaction(async (tx) => {
    const added: Position[] = []
    for (const [index, input] of inputs.entries()) {
      try {
        added.push(await addOnePosition(tx, input))
      } catch (error) {
        throw isItemFault(error) ? new BulkItemError(index, error) : error
      }
    }
    return added
  })
}

async function readPositionRow(db: Db, id: number): Promise<Position> {
  const [found] = await db.select().from(position).where(eq(position.id, id))
  if (!found) throw new NotFoundError('position', id)
  return found
}

/** The registry row for a nullable reference: absent when the position names none. */
async function referencedRow<N extends RegistryName>(
  db: Db,
  name: N,
  id: number | null,
): Promise<RegistryRowOf<N> | null> {
  return id === null ? null : findRegistryRow(db, name, id)
}

async function readReferences(db: Db, row: Position): Promise<PositionReferences> {
  const [workFormat, seniority, applyRoute] = await Promise.all([
    referencedRow(db, 'work_format', row.workFormatId),
    referencedRow(db, 'seniority', row.seniorityId),
    referencedRow(db, 'apply_route', row.applyRouteId),
  ])
  return { workFormat, seniority, applyRoute }
}

/** Latest by time, then by id: events written in one transaction share a timestamp. */
async function readLatestStage(db: Db, positionId: number): Promise<LatestStage | null> {
  const [event] = await db
    .select()
    .from(positionStageEvent)
    .where(eq(positionStageEvent.positionId, positionId))
    .orderBy(desc(positionStageEvent.occurredAt), desc(positionStageEvent.id))
    .limit(1)
  if (!event) return null
  const stage = await referencedRow(db, 'stage', event.stageId)
  const phase = await referencedRow(db, 'phase', stage?.phaseId ?? null)
  return { event, stage, phase }
}

/** The newest score under each criteria set; a position keeps its history, the modal shows the head of each. */
function latestPerSet(scores: readonly Score[]): Score[] {
  const seen = new Set<number>()
  return scores.filter((score) => {
    if (seen.has(score.criteriaSetId)) return false
    seen.add(score.criteriaSetId)
    return true
  })
}

async function readRatings(db: Db, scoreIds: readonly number[]): Promise<RatingDetail[]> {
  const rows = await db
    .select({ rating: positionRating, requirementKey: requirement.key, requirementLabel: requirement.label })
    .from(positionRating)
    .innerJoin(requirement, eq(requirement.id, positionRating.requirementId))
    .where(inArray(positionRating.scoreId, [...scoreIds]))
    .orderBy(asc(requirement.sort), asc(requirement.id))
  return rows
}

/** Joined without an archival filter, so a penalty kind archived later keeps its label. */
async function readPenalties(db: Db, scoreIds: readonly number[]): Promise<PenaltyDetail[]> {
  const rows = await db
    .select({ penalty: positionPenalty, kindLabel: penaltyKind.label })
    .from(positionPenalty)
    .innerJoin(penaltyKind, eq(penaltyKind.id, positionPenalty.penaltyKindId))
    .where(inArray(positionPenalty.scoreId, [...scoreIds]))
    .orderBy(asc(positionPenalty.id))
  return rows
}

async function readLatestScores(db: Db, positionId: number): Promise<ScoreDetail[]> {
  const history = await db
    .select()
    .from(positionScore)
    .where(eq(positionScore.positionId, positionId))
    .orderBy(asc(positionScore.criteriaSetId), desc(positionScore.scoredAt), desc(positionScore.id))
  const latest = latestPerSet(history)
  if (latest.length === 0) return []
  const ids = latest.map((score) => score.id)
  const [ratings, penalties] = await Promise.all([readRatings(db, ids), readPenalties(db, ids)])
  return latest.map((score) => ({
    score,
    ratings: ratings.filter((entry) => entry.rating.scoreId === score.id),
    penalties: penalties.filter((entry) => entry.penalty.scoreId === score.id),
  }))
}

/** Oldest first. The reason is whichever of the two registries the `kind` carries. */
async function readDispositions(db: Db, positionId: number): Promise<DispositionDetail[]> {
  const rows = await db
    .select({
      disposition: positionDisposition,
      setAsideLabel: setAsideReason.label,
      rejectionLabel: rejectionReason.label,
    })
    .from(positionDisposition)
    .leftJoin(setAsideReason, eq(setAsideReason.id, positionDisposition.setAsideReasonId))
    .leftJoin(rejectionReason, eq(rejectionReason.id, positionDisposition.rejectionReasonId))
    .where(eq(positionDisposition.positionId, positionId))
    .orderBy(asc(positionDisposition.notedAt), asc(positionDisposition.id))
  return rows.map((row) => ({
    disposition: row.disposition,
    reasonLabel: row.setAsideLabel ?? row.rejectionLabel,
  }))
}

/** In the order first touch is derived in: the day touched, then when recorded, then id. */
async function readOrigins(db: Db, positionId: number): Promise<OriginDetail[]> {
  const rows = await db
    .select({ origin, routeLabel: route.label })
    .from(origin)
    .leftJoin(route, eq(route.id, origin.routeId))
    .where(eq(origin.positionId, positionId))
    .orderBy(asc(origin.touchedOn), asc(origin.recordedAt), asc(origin.id))
  return rows
}

/**
 * The detail modal's read: the position with its company, its summary, its latest stage
 * event, the latest score under each criteria set, its dispositions and its origins. Every
 * registry label is read whatever its archival state, so nothing renders blank.
 */
export async function getPosition(db: Db, id: number): Promise<PositionDetail> {
  const row = await readPositionRow(db, id)
  const [company, references, summary, latestStage, scores, dispositions, origins] = await Promise.all([
    findCompany(db, row.companyId),
    readReferences(db, row),
    findSummary(db, id),
    readLatestStage(db, id),
    readLatestScores(db, id),
    readDispositions(db, id),
    readOrigins(db, id),
  ])
  return { position: row, company, references, summary, latestStage, scores, dispositions, origins }
}

/**
 * The subqueries below pick the latest row of a table for the row being read, so they need
 * the table under a second name. Drizzle renders an aliased table's columns qualified by that
 * name but writes the bare alias in a `from`, so each subquery names its table and alias by hand.
 */
const EVENT_ALIAS = 'latest_event'
const SCORE_ALIAS = 'latest_score'
const latestEvent = alias(positionStageEvent, EVENT_ALIAS)
const newerScore = alias(positionScore, SCORE_ALIAS)

/** The id of the position's latest stage event: by time, then by id. */
function latestStageEventId(): SQL {
  return sql`(select ${latestEvent.id} from ${positionStageEvent} as ${sql.identifier(EVENT_ALIAS)} where ${latestEvent.positionId} = ${position.id}
    order by ${latestEvent.occurredAt} desc, ${latestEvent.id} desc limit 1)`
}

/** The criteria set a search reads scores from: the one named, else the active default. */
function criteriaSetFor(query: PositionQuery): SQL {
  if (query.criteriaSetId !== undefined) return sql`${query.criteriaSetId}`
  return sql`(select ${criteriaSet.id} from ${criteriaSet} where ${criteriaSet.isDefault} and ${criteriaSet.archivedAt} is null)`
}

/** The id of the position's latest score under that set: by day scored, then by id. */
function latestScoreId(setId: SQL): SQL {
  return sql`(select ${newerScore.id} from ${positionScore} as ${sql.identifier(SCORE_ALIAS)} where ${newerScore.positionId} = ${position.id}
    and ${newerScore.criteriaSetId} = ${setId} order by ${newerScore.scoredAt} desc, ${newerScore.id} desc limit 1)`
}

function isSetAside(): SQL<boolean> {
  return sql<boolean>`exists (select 1 from ${positionDisposition}
    where ${positionDisposition.positionId} = ${position.id} and ${positionDisposition.kind} = ${SET_ASIDE_KIND})`
}

/** The WHERE conditions a query asks for; a filter it leaves out adds none. */
function conditionsOf(query: PositionQuery): SQL[] {
  const conditions: SQL[] = []
  if (query.companyId !== undefined) conditions.push(eq(position.companyId, query.companyId))
  if (query.phaseId !== undefined) conditions.push(eq(stageTable.phaseId, query.phaseId))
  if (query.recommendApply !== undefined) conditions.push(eq(positionScore.recommendApply, query.recommendApply))
  if (query.setAside === 'exclude') conditions.push(sql`not ${isSetAside()}`)
  if (query.setAside === 'only') conditions.push(isSetAside())
  if (query.clientHidden === 'exclude') conditions.push(eq(position.clientHidden, false))
  if (query.clientHidden === 'only') conditions.push(eq(position.clientHidden, true))
  return conditions
}

/**
 * The positions a board or grid draws, newest seen first with id as the tie-break so pages
 * tile without overlap. One query: the latest stage event and the latest score are found per
 * row by a correlated subquery over the indexed key, so a page costs one round trip however
 * many rows it holds.
 *
 * Defaults, which a reader should not have to infer from the schema: set-aside positions and
 * client-hidden positions are both left out unless `query.setAside` / `query.clientHidden`
 * says `include` (everything) or `only` (just those). A position with no score under the
 * criteria set matches neither answer to `recommendApply`. There is no total: a page shorter
 * than `limit` is the end of the list.
 */
export async function searchPositions(db: Db, query: PositionQuery): Promise<PositionListRow[]> {
  const rows = await db
    .select({
      position,
      company: companyTable,
      stage: stageTable,
      phase: phaseTable,
      score: positionScore,
      setAside: isSetAside(),
    })
    .from(position)
    .innerJoin(companyTable, eq(companyTable.id, position.companyId))
    .leftJoin(positionStageEvent, eq(positionStageEvent.id, latestStageEventId()))
    .leftJoin(stageTable, eq(stageTable.id, positionStageEvent.stageId))
    .leftJoin(phaseTable, eq(phaseTable.id, stageTable.phaseId))
    .leftJoin(positionScore, eq(positionScore.id, latestScoreId(criteriaSetFor(query))))
    .where(and(...conditionsOf(query)))
    .orderBy(desc(position.seenAt), desc(position.id))
    .limit(query.limit)
    .offset(query.offset)
  return rows
}

/** The columns a patch changes, with the normalised role kept in step with the title. */
function patchColumns(patch: PositionPatch): Partial<typeof position.$inferInsert> {
  const defined = pickDefined(patch, [...EDITABLE_COLUMNS, ...PATCH_ONLY_COLUMNS])
  const { roleTitle } = patch
  return roleTitle === undefined ? defined : { ...defined, roleTitle, roleNorm: normaliseName(roleTitle) }
}

/**
 * The references in a patch that name a different row from the one stored. Archival blocks a
 * new reference and not the continued existence of one already stored, so a client that sends
 * back a whole object with an unchanged, since-archived reference is not refused for it.
 */
function changedReferences(patch: PositionPatch, stored: Position): ReferencedIds {
  return Object.fromEntries(
    POSITION_REFERENCES.flatMap(([column]) =>
      patch[column] !== undefined && patch[column] !== stored[column] ? [[column, patch[column]]] : [],
    ),
  )
}

/**
 * Changes some columns of one position and returns the row as stored, as a new object; the
 * patch is not touched. `priorityRank` is accepted here and by no other function, because it
 * is the user's own hand-ranking and no import may write it. Only the columns listed in
 * `EDITABLE_COLUMNS` and `PATCH_ONLY_COLUMNS` are copied from the patch, so a key outside the
 * type (the company, the key, a timestamp) is ignored even when the object carries it. A
 * registry reference that differs from the stored one must be usable, as on creation; one
 * that is unchanged is not re-checked. A title or disambiguator that now collides with
 * another position at the same employer is a `ConflictError`, and nothing is written.
 *
 * An empty patch changes nothing and returns the row as it is, or `NotFoundError` when there
 * is none.
 */
export async function updatePosition(db: Db, id: number, patch: PositionPatch): Promise<Position> {
  const stored = await readPositionRow(db, id)
  const columns = patchColumns(patch)
  if (Object.keys(columns).length === 0) return stored
  await assertReferencesUsable(db, changedReferences(patch, stored))
  try {
    const [updated] = await db.update(position).set(columns).where(eq(position.id, id)).returning()
    if (!updated) throw new NotFoundError('position', id)
    return updated
  } catch (error) {
    throw asConflict(error, { role: patch.roleTitle ?? patch.disambiguator ?? String(id), key: String(id) })
  }
}
