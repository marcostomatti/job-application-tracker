import { and, asc, desc, eq, inArray, sql, type InferSelectModel, type SQL } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'

import { BulkItemError, ConflictError, NotFoundError } from '../../errors.ts'
import type { PostingInput, PostingPatch, PostingQuery } from '../../schemas/postings.ts'
import { isUniqueViolation } from '../driver-faults.ts'
import { criteriaSet, requirement } from '../schema/criteria.ts'
import { postingDisposition, postingStageEvent } from '../schema/dispositions.ts'
import { company as companyTable, normaliseName, posting } from '../schema/postings.ts'
import { origin } from '../schema/provenance.ts'
import { penaltyKind, phase as phaseTable, rejectionReason, route, setAsideReason, stage as stageTable } from '../schema/registries.ts'
import { postingPenalty, postingRating, postingScore } from '../schema/scores.ts'
import { findCompany, upsertCompany, type Company } from './companies.ts'
import { nonSupersededSetIds } from './criteria.ts'
import type { Db } from './db.ts'
import { isItemFault } from './item-fault.ts'
import { pickDefined } from './pick-defined.ts'
import { assertNotArchived, findRegistryRow, type RegistryName, type RegistryRowOf } from './registries.ts'
import { findSummary, type PostingSummary } from './summaries.ts'

export type Posting = InferSelectModel<typeof posting>
type StageEvent = InferSelectModel<typeof postingStageEvent>
type Score = InferSelectModel<typeof postingScore>
type Rating = InferSelectModel<typeof postingRating>
type Penalty = InferSelectModel<typeof postingPenalty>
type Disposition = InferSelectModel<typeof postingDisposition>
type Origin = InferSelectModel<typeof origin>

/**
 * The registry rows a posting names, each read whatever its archival state: a row archived
 * after the posting was stored must still render, so a label never goes blank because of
 * what happened to the vocabulary later.
 */
export type PostingReferences = {
  readonly workFormat: RegistryRowOf<'work_format'> | null
  readonly seniority: RegistryRowOf<'seniority'> | null
  readonly applyRoute: RegistryRowOf<'apply_route'> | null
}

/** The latest stage event of a posting, with the stage it names and that stage's phase. */
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

/** Everything the detail modal shows for one posting. */
export type PostingDetail = {
  readonly posting: Posting
  readonly company: Company
  readonly references: PostingReferences
  readonly summary: PostingSummary | null
  readonly latestStage: LatestStage | null
  readonly scores: readonly ScoreDetail[]
  readonly dispositions: readonly DispositionDetail[]
  readonly origins: readonly OriginDetail[]
}

/**
 * One row of the board and the grid. `stage` and `phase` come from the posting's latest
 * stage event; `score` is the latest score under the criteria set the query named; else, when
 * the query asked for an answer to `recommendApply`, the standing score that gives it; else the
 * default set's latest. `setAside` says whether any disposition of kind `set_aside` exists, so a
 * caller that asked to include set-aside postings can tell which they are.
 */
export type PostingListRow = {
  readonly posting: Posting
  readonly company: Company
  readonly stage: RegistryRowOf<'stage'> | null
  readonly phase: RegistryRowOf<'phase'> | null
  readonly score: Score | null
  readonly setAside: boolean
}

/** The internal discriminator of a disposition that sets a lead aside. */
export const SET_ASIDE_KIND = 'set_aside'

/** The constraint names Postgres reports on a duplicate, as `0012_rename_position_to_posting.sql` renamed them. */
const KEY_CONSTRAINT = 'posting_posting_key_unique'
const ROLE_CONSTRAINT = 'posting_company_role_disambiguator_unique'

/**
 * The columns of a posting that name a registry row, and the registry each names. They are
 * data so the archival guard stays a loop: nothing here branches on which registry it is.
 */
const POSTING_REFERENCES = [
  ['workFormatId', 'work_format'],
  ['seniorityId', 'seniority'],
  ['applyRouteId', 'apply_route'],
] as const satisfies readonly (readonly [keyof Posting, RegistryName])[]

type ReferencedIds = Partial<Record<(typeof POSTING_REFERENCES)[number][0], number | null>>

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
] as const satisfies readonly (keyof Posting)[]

/**
 * What a patch may additionally set. `priorityRank` is the user's own hand-ranking: it is
 * listed here, and in no list a creation reads, which is the whole of "no import may write it".
 */
const PATCH_ONLY_COLUMNS = ['disambiguator', 'priorityRank'] as const satisfies readonly (keyof Posting)[]

/**
 * Refuses a write that names a registry row it may not name. It runs before the write so an
 * archived or missing row is refused with its own error, and checks only ids the call
 * carries: `null` clears a reference and absent leaves it alone.
 */
async function assertReferencesUsable(db: Db, ids: ReferencedIds): Promise<void> {
  for (const [column, registry] of POSTING_REFERENCES) {
    const id = ids[column]
    if (typeof id === 'number') await assertNotArchived(db, registry, id)
  }
}

/**
 * The key a posting gets when the caller names none: employer and role, each in its
 * normalised form, with the disambiguator when there is one. The same role reposted derives
 * the same key, which is what makes a repost one posting.
 */
function derivedPostingKey(companyNorm: string, roleNorm: string, disambiguatorText: string): string {
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
    return new ConflictError('posting_key', describe.key, { cause: error })
  }
  if (isUniqueViolation(error, ROLE_CONSTRAINT)) {
    return new ConflictError('posting', describe.role, { cause: error })
  }
  return error
}

/** The row to insert for one input, given the company it resolved to. */
function insertValuesOf(input: PostingInput, owner: Company): typeof posting.$inferInsert {
  const roleNorm = normaliseName(input.roleTitle)
  const given = input.disambiguator ?? ''
  return {
    ...pickDefined(input, EDITABLE_COLUMNS),
    postingKey: input.postingKey ?? derivedPostingKey(owner.nameNorm, roleNorm, given),
    companyId: owner.id,
    roleTitle: input.roleTitle,
    roleNorm,
    disambiguator: given,
  }
}

async function addOnePosting(db: Db, input: PostingInput): Promise<Posting> {
  await assertReferencesUsable(db, input)
  const owner = await upsertCompany(db, input.company)
  const values = insertValuesOf(input, owner)
  try {
    const [created] = await db.insert(posting).values(values).returning()
    if (!created) throw new NotFoundError('posting', values.postingKey)
    return created
  } catch (error) {
    const suffix = values.disambiguator === '' ? '' : ` (${values.disambiguator})`
    throw asConflict(error, { role: `${values.roleTitle} at ${owner.name}${suffix}`, key: values.postingKey })
  }
}

/**
 * Records postings, all or none. Every item runs inside one transaction, in order, so the
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
export async function addPostings(db: Db, inputs: readonly PostingInput[]): Promise<Posting[]> {
  if (inputs.length === 0) return []
  return db.transaction(async (tx) => {
    const added: Posting[] = []
    for (const [index, input] of inputs.entries()) {
      try {
        added.push(await addOnePosting(tx, input))
      } catch (error) {
        throw isItemFault(error) ? new BulkItemError(index, error) : error
      }
    }
    return added
  })
}

async function readPostingRow(db: Db, id: number): Promise<Posting> {
  const [found] = await db.select().from(posting).where(eq(posting.id, id))
  if (!found) throw new NotFoundError('posting', id)
  return found
}

/** The registry row for a nullable reference: absent when the posting names none. */
async function referencedRow<N extends RegistryName>(
  db: Db,
  name: N,
  id: number | null,
): Promise<RegistryRowOf<N> | null> {
  return id === null ? null : findRegistryRow(db, name, id)
}

async function readReferences(db: Db, row: Posting): Promise<PostingReferences> {
  const [workFormat, seniority, applyRoute] = await Promise.all([
    referencedRow(db, 'work_format', row.workFormatId),
    referencedRow(db, 'seniority', row.seniorityId),
    referencedRow(db, 'apply_route', row.applyRouteId),
  ])
  return { workFormat, seniority, applyRoute }
}

/** Latest by time, then by id: events written in one transaction share a timestamp. */
async function readLatestStage(db: Db, postingId: number): Promise<LatestStage | null> {
  const [event] = await db
    .select()
    .from(postingStageEvent)
    .where(eq(postingStageEvent.postingId, postingId))
    .orderBy(desc(postingStageEvent.occurredAt), desc(postingStageEvent.id))
    .limit(1)
  if (!event) return null
  const stage = await referencedRow(db, 'stage', event.stageId)
  const phase = await referencedRow(db, 'phase', stage?.phaseId ?? null)
  return { event, stage, phase }
}

/** The newest score under each criteria set; a posting keeps its history, the modal shows the head of each set that is not superseded. */
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
    .select({ rating: postingRating, requirementKey: requirement.key, requirementLabel: requirement.label })
    .from(postingRating)
    .innerJoin(requirement, eq(requirement.id, postingRating.requirementId))
    .where(inArray(postingRating.scoreId, [...scoreIds]))
    .orderBy(asc(requirement.sort), asc(requirement.id))
  return rows
}

/** Joined without an archival filter, so a penalty kind archived later keeps its label. */
async function readPenalties(db: Db, scoreIds: readonly number[]): Promise<PenaltyDetail[]> {
  const rows = await db
    .select({ penalty: postingPenalty, kindLabel: penaltyKind.label })
    .from(postingPenalty)
    .innerJoin(penaltyKind, eq(penaltyKind.id, postingPenalty.penaltyKindId))
    .where(inArray(postingPenalty.scoreId, [...scoreIds]))
    .orderBy(asc(postingPenalty.id))
  return rows
}

async function readLatestScores(db: Db, postingId: number): Promise<ScoreDetail[]> {
  const history = await db
    .select()
    .from(postingScore)
    .where(and(eq(postingScore.postingId, postingId), sql`${postingScore.criteriaSetId} in ${nonSupersededSetIds()}`))
    .orderBy(asc(postingScore.criteriaSetId), desc(postingScore.scoredAt), desc(postingScore.id))
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
async function readDispositions(db: Db, postingId: number): Promise<DispositionDetail[]> {
  const rows = await db
    .select({
      disposition: postingDisposition,
      setAsideLabel: setAsideReason.label,
      rejectionLabel: rejectionReason.label,
    })
    .from(postingDisposition)
    .leftJoin(setAsideReason, eq(setAsideReason.id, postingDisposition.setAsideReasonId))
    .leftJoin(rejectionReason, eq(rejectionReason.id, postingDisposition.rejectionReasonId))
    .where(eq(postingDisposition.postingId, postingId))
    .orderBy(asc(postingDisposition.notedAt), asc(postingDisposition.id))
  return rows.map((row) => ({
    disposition: row.disposition,
    reasonLabel: row.setAsideLabel ?? row.rejectionLabel,
  }))
}

/** In the order first touch is derived in: the day touched, then when recorded, then id. */
async function readOrigins(db: Db, postingId: number): Promise<OriginDetail[]> {
  const rows = await db
    .select({ origin, routeLabel: route.label })
    .from(origin)
    .leftJoin(route, eq(route.id, origin.routeId))
    .where(eq(origin.postingId, postingId))
    .orderBy(asc(origin.touchedOn), asc(origin.recordedAt), asc(origin.id))
  return rows
}

/**
 * The detail modal's read: the posting with its company, its summary, its latest stage
 * event, the latest score under each criteria set that is not superseded (the same sets
 * `getBestScores` keeps, so the modal and the "+n" chip count the same lenses), its
 * dispositions and its origins. Every
 * registry label is read whatever its archival state, so nothing renders blank.
 */
export async function getPosting(db: Db, id: number): Promise<PostingDetail> {
  const row = await readPostingRow(db, id)
  const [company, references, summary, latestStage, scores, dispositions, origins] = await Promise.all([
    findCompany(db, row.companyId),
    readReferences(db, row),
    findSummary(db, id),
    readLatestStage(db, id),
    readLatestScores(db, id),
    readDispositions(db, id),
    readOrigins(db, id),
  ])
  return { posting: row, company, references, summary, latestStage, scores, dispositions, origins }
}

/**
 * The subqueries below pick the latest row of a table for the row being read, so they need
 * the table under a second name. Drizzle renders an aliased table's columns qualified by that
 * name but writes the bare alias in a `from`, so each subquery names its table and alias by hand.
 */
const EVENT_ALIAS = 'latest_event'
const SCORE_ALIAS = 'latest_score'
const latestEvent = alias(postingStageEvent, EVENT_ALIAS)
const newerScore = alias(postingScore, SCORE_ALIAS)

/** The id of the posting's latest stage event: by time, then by id. */
function latestStageEventId(): SQL {
  return sql`(select ${latestEvent.id} from ${postingStageEvent} as ${sql.identifier(EVENT_ALIAS)} where ${latestEvent.postingId} = ${posting.id}
    order by ${latestEvent.occurredAt} desc, ${latestEvent.id} desc limit 1)`
}

/** The criteria set a search reads scores from: the one named, else the active default. */
function criteriaSetFor(query: PostingQuery): SQL {
  if (query.criteriaSetId !== undefined) return sql`${query.criteriaSetId}`
  return sql`(select ${criteriaSet.id} from ${criteriaSet} where ${criteriaSet.isDefault} and ${criteriaSet.archivedAt} is null)`
}

/** The id of the posting's latest score under that set: by day scored, then by id. */
function latestScoreId(setId: SQL): SQL {
  return sql`(select ${newerScore.id} from ${postingScore} as ${sql.identifier(SCORE_ALIAS)} where ${newerScore.postingId} = ${posting.id}
    and ${newerScore.criteriaSetId} = ${setId} order by ${newerScore.scoredAt} desc, ${newerScore.id} desc limit 1)`
}

const CANDIDATE_ALIAS = 'standing_score'
const standingScore = alias(postingScore, CANDIDATE_ALIAS)

/**
 * The part of a statement that makes `standing_score` a standing score of the row being read: a
 * score of that posting, under a non-superseded criteria set (`nonSupersededSetIds`), and the
 * latest of its set (by day, then id). Each set's latest is picked first and any flag tested
 * after, so a recommendation that a later score withdrew does not count.
 */
function isStandingScore(): SQL {
  return sql`${standingScore.postingId} = ${posting.id}
    and ${standingScore.criteriaSetId} in ${nonSupersededSetIds()}
    and ${standingScore.id} = ${latestScoreId(sql`${standingScore.criteriaSetId}`)}`
}

/** Whether the posting has a standing score, and, when `recommending` is set, one that recommends apply. */
function hasStandingScore(recommending: boolean): SQL<boolean> {
  const flag = recommending ? sql`and ${standingScore.recommendApply}` : sql``
  return sql<boolean>`exists (select 1 from ${postingScore} as ${sql.identifier(CANDIDATE_ALIAS)} where ${isStandingScore()} ${flag})`
}

/**
 * The id of the standing score that gives the answer `answer` to `recommendApply`, the one a row
 * displays when it was listed for that answer without a set named. Several sets can give the
 * same answer, so the pick is the best-scoring (the largest `overall`, which section 8
 * normalises so it compares across sets, and section 9.2 shows "the best-scoring set"), then the
 * later day, then the later id, so the same data always shows the same score. Null when none gives it.
 */
function answeringScoreId(answer: boolean): SQL {
  return sql`(select ${standingScore.id} from ${postingScore} as ${sql.identifier(CANDIDATE_ALIAS)}
    where ${isStandingScore()} and ${standingScore.recommendApply} = ${answer}
    order by ${standingScore.overall} desc nulls last, ${standingScore.scoredAt} desc, ${standingScore.id} desc limit 1)`
}

/**
 * The `recommendApply` filter. With a set named it is that set's answer, read from the latest
 * score the row already carries, superseded or not. With none named it is the spec's section 8
 * rule across sets: `true` when at least one non-superseded set's latest score recommends apply,
 * and `false` when the posting has such scores and none of them does. A posting with no
 * standing score matches neither answer, as an unscored one always has.
 */
function recommendApplyCondition(answer: boolean, criteriaSetId: number | undefined): SQL {
  if (criteriaSetId !== undefined) return eq(postingScore.recommendApply, answer)
  return answer ? hasStandingScore(true) : sql`(${hasStandingScore(false)} and not ${hasStandingScore(true)})`
}

/**
 * The id of the score a row carries. With a set named, that set's latest. Asked for an answer
 * to `recommendApply` with none named, the standing score that gives the answer (`answeringScoreId`),
 * so a row never displays a score that denies why it was listed. Otherwise the default set's latest.
 */
function displayedScoreId(query: PostingQuery): SQL {
  if (query.criteriaSetId === undefined && query.recommendApply !== undefined) return answeringScoreId(query.recommendApply)
  return latestScoreId(criteriaSetFor(query))
}

function isSetAside(): SQL<boolean> {
  return sql<boolean>`exists (select 1 from ${postingDisposition}
    where ${postingDisposition.postingId} = ${posting.id} and ${postingDisposition.kind} = ${SET_ASIDE_KIND})`
}

/** The WHERE conditions a query asks for; a filter it leaves out adds none. */
function conditionsOf(query: PostingQuery): SQL[] {
  const conditions: SQL[] = []
  if (query.companyId !== undefined) conditions.push(eq(posting.companyId, query.companyId))
  if (query.phaseId !== undefined) conditions.push(eq(stageTable.phaseId, query.phaseId))
  if (query.recommendApply !== undefined) conditions.push(recommendApplyCondition(query.recommendApply, query.criteriaSetId))
  if (query.setAside === 'exclude') conditions.push(sql`not ${isSetAside()}`)
  if (query.setAside === 'only') conditions.push(isSetAside())
  if (query.clientHidden === 'exclude') conditions.push(eq(posting.clientHidden, false))
  if (query.clientHidden === 'only') conditions.push(eq(posting.clientHidden, true))
  return conditions
}

/**
 * The postings a board or grid draws, newest seen first with id as the tie-break so pages
 * tile without overlap. One query: the latest stage event and the latest score are found per
 * row by a correlated subquery over the indexed key, so a page costs one round trip however
 * many rows it holds.
 *
 * Defaults, which a reader should not have to infer from the schema: set-aside postings and
 * client-hidden postings are both left out unless `query.setAside` / `query.clientHidden`
 * says `include` (everything) or `only` (just those). A posting with no score under the
 * criteria set matches neither answer to `recommendApply`. There is no total: a page shorter
 * than `limit` is the end of the list.
 *
 * `recommendApply` with no `criteriaSetId` is the across-sets rule of the spec's section 8,
 * not the default set's answer: a posting matches `true` when any non-superseded set's latest
 * score recommends apply. The row's `score` is then the standing score that gives the answer
 * (the best-scoring one when several do), not the default set's, so a listed row never shows a
 * score that contradicts why it is listed. With no `recommendApply` either, it is the default set's.
 */
export async function searchPostings(db: Db, query: PostingQuery): Promise<PostingListRow[]> {
  const rows = await db
    .select({
      posting,
      company: companyTable,
      stage: stageTable,
      phase: phaseTable,
      score: postingScore,
      setAside: isSetAside(),
    })
    .from(posting)
    .innerJoin(companyTable, eq(companyTable.id, posting.companyId))
    .leftJoin(postingStageEvent, eq(postingStageEvent.id, latestStageEventId()))
    .leftJoin(stageTable, eq(stageTable.id, postingStageEvent.stageId))
    .leftJoin(phaseTable, eq(phaseTable.id, stageTable.phaseId))
    .leftJoin(postingScore, eq(postingScore.id, displayedScoreId(query)))
    .where(and(...conditionsOf(query)))
    .orderBy(desc(posting.seenAt), desc(posting.id))
    .limit(query.limit)
    .offset(query.offset)
  return rows
}

/** The columns a patch changes, with the normalised role kept in step with the title. */
function patchColumns(patch: PostingPatch): Partial<typeof posting.$inferInsert> {
  const defined = pickDefined(patch, [...EDITABLE_COLUMNS, ...PATCH_ONLY_COLUMNS])
  const { roleTitle } = patch
  return roleTitle === undefined ? defined : { ...defined, roleTitle, roleNorm: normaliseName(roleTitle) }
}

/**
 * The references in a patch that name a different row from the one stored. Archival blocks a
 * new reference and not the continued existence of one already stored, so a client that sends
 * back a whole object with an unchanged, since-archived reference is not refused for it.
 */
function changedReferences(patch: PostingPatch, stored: Posting): ReferencedIds {
  return Object.fromEntries(
    POSTING_REFERENCES.flatMap(([column]) =>
      patch[column] !== undefined && patch[column] !== stored[column] ? [[column, patch[column]]] : [],
    ),
  )
}

/**
 * Changes some columns of one posting and returns the row as stored, as a new object; the
 * patch is not touched. `priorityRank` is accepted here and by no other function, because it
 * is the user's own hand-ranking and no import may write it. Only the columns listed in
 * `EDITABLE_COLUMNS` and `PATCH_ONLY_COLUMNS` are copied from the patch, so a key outside the
 * type (the company, the key, a timestamp) is ignored even when the object carries it. A
 * registry reference that differs from the stored one must be usable, as on creation; one
 * that is unchanged is not re-checked. A title or disambiguator that now collides with
 * another posting at the same employer is a `ConflictError`, and nothing is written.
 *
 * An empty patch changes nothing and returns the row as it is, or `NotFoundError` when there
 * is none.
 */
export async function updatePosting(db: Db, id: number, patch: PostingPatch): Promise<Posting> {
  const stored = await readPostingRow(db, id)
  const columns = patchColumns(patch)
  if (Object.keys(columns).length === 0) return stored
  await assertReferencesUsable(db, changedReferences(patch, stored))
  try {
    const [updated] = await db.update(posting).set(columns).where(eq(posting.id, id)).returning()
    if (!updated) throw new NotFoundError('posting', id)
    return updated
  } catch (error) {
    throw asConflict(error, { role: patch.roleTitle ?? patch.disambiguator ?? String(id), key: String(id) })
  }
}
