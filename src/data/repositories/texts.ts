import { and, asc, desc, eq, inArray, max, type InferSelectModel, type SQL } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'

import { ConflictError, NotFoundError } from '../../errors.ts'
import type { NewTextInput, TextLinkInput, TextQuery, TextUpdateInput } from '../../schemas/texts.ts'
import { isUniqueViolation } from '../driver-faults.ts'
import { LABEL_VERSION_INDEX, textAsset, textAssetPosting } from '../schema/texts.ts'
import type { Db } from './db.ts'
import { pickDefined } from './pick-defined.ts'
import { assertPostingExists } from './posting-exists.ts'
import { assertNotArchived } from './registries.ts'

export type TextLink = InferSelectModel<typeof textAssetPosting>

export type TextAsset = InferSelectModel<typeof textAsset>

/**
 * The optional column a write copies from its input. `label` and `body` are named where the
 * row is built, and `version`, `id` and `createdAt` are the data layer's alone, so an object
 * that carries them at run time cannot write them.
 */
const OPTIONAL_COLUMNS = ['textTypeId'] as const satisfies readonly (keyof NewTextInput & keyof TextUpdateInput)[]

async function insertText(db: Db, values: typeof textAsset.$inferInsert): Promise<TextAsset> {
  const [written] = await db.insert(textAsset).values(values).returning()
  if (!written) throw new Error('The text insert returned no row.')
  return written
}

/**
 * Adds a text as version 1. A label that already names a text is a `ConflictError`: a new
 * wording of an existing text is `updateText`, and the unique index on `(label, version)`
 * decides it, so two adds of one label cannot both succeed. An archived or unknown text type
 * is refused (`ArchivedError`, `NotFoundError`).
 */
export async function addText(db: Db, input: NewTextInput): Promise<TextAsset> {
  if (input.textTypeId != null) await assertNotArchived(db, 'text_type', input.textTypeId)
  try {
    return await insertText(db, { label: input.label, body: input.body, ...pickDefined(input, OPTIONAL_COLUMNS) })
  } catch (error) {
    if (isUniqueViolation(error, LABEL_VERSION_INDEX)) {
      throw new ConflictError('text label', input.label, { cause: error })
    }
    throw error
  }
}

/** The newest version of a label, or undefined when the label names nothing. */
async function readNewest(db: Db, label: string): Promise<TextAsset | undefined> {
  const [newest] = await db
    .select()
    .from(textAsset)
    .where(eq(textAsset.label, label))
    .orderBy(desc(textAsset.version))
    .limit(1)
  return newest
}

/**
 * Writes the next version of a text and leaves every earlier one as it was, because a cover
 * letter's earlier wording is worth keeping. The text is named by its label, which is what
 * groups its versions; a label with no text is `NotFoundError`. The new row is one past the
 * newest version, read inside the transaction, and keeps that version's text type unless the
 * input names one (`null` clears it). Only a type the input newly names is checked against
 * archival, so a type archived since the text was written does not block editing the text.
 *
 * Nothing locks the label, and that is the opposite of `createCriteriaVersion`, whose shape is
 * the same (read the highest version, insert one past it, a unique constraint behind). The
 * difference is what the loser should experience. A criteria version is an independent copy, so
 * queueing the callers and giving each its own number is right. A text asset is one document
 * being edited: a caller that silently received version 3, built on someone else's version 2,
 * would have an edit quietly layered onto wording it never saw. So the loser is told, and
 * re-reads.
 *
 * Two callers that both read version 1 both try to write version 2,
 * and the unique index on `(label, version)` lets one through: the other waits on it, then
 * fails and is reported as a `ConflictError`, with the driver fault on `cause` and none of
 * its statement in the message. That failure means someone else edited the text first, so the
 * caller re-reads it and decides, and nothing is written twice.
 */
export async function updateText(db: Db, input: TextUpdateInput): Promise<TextAsset> {
  return db.transaction(async (tx) => {
    const newest = await readNewest(tx, input.label)
    if (!newest) throw new NotFoundError('text', input.label)
    if (input.textTypeId != null) await assertNotArchived(tx, 'text_type', input.textTypeId)
    const version = newest.version + 1
    try {
      return await insertText(tx, {
        label: input.label,
        version,
        textTypeId: newest.textTypeId,
        ...pickDefined(input, OPTIONAL_COLUMNS),
        body: input.body,
      })
    } catch (error) {
      if (isUniqueViolation(error, LABEL_VERSION_INDEX)) {
        throw new ConflictError('text version', `${input.label} ${version}`, {
          cause: error,
          message: `text ${input.label} was changed by another write; version ${version} already exists`,
        })
      }
      throw error
    }
  })
}

/**
 * The newest version of each label, optionally only the labels whose newest version has this
 * type. The type is judged on the newest version, never on an older one: a text that moved to
 * another type is no longer listed under the old one, and filtering the rows first would
 * resurrect its old version in its place.
 */
async function readNewestPerLabel(db: Db, textTypeId: number | undefined): Promise<TextAsset[]> {
  const earlier = alias(textAsset, 'earlier_version')
  const newestOfLabel = db.select({ version: max(earlier.version) }).from(earlier).where(eq(earlier.label, textAsset.label))
  const conditions: SQL[] = [eq(textAsset.version, newestOfLabel)]
  if (textTypeId !== undefined) conditions.push(eq(textAsset.textTypeId, textTypeId))
  return db
    .select()
    .from(textAsset)
    .where(and(...conditions))
    .orderBy(asc(textAsset.label), asc(textAsset.id))
}

/**
 * The texts, by label. By default each label appears once, as its newest version. With
 * `includeHistory`, every version of the labels that match is listed, newest first within a
 * label, so an earlier wording can be read back. `textTypeId` selects labels by the type their
 * newest version has now, and the history of a selected label is listed whole even where an
 * older version had another type. A text whose type was archived afterwards is still listed.
 *
 * With `postingId`, the list is exactly the versions linked to that posting, by label and then
 * newest first, and `includeHistory` changes nothing, because a link already names a version.
 * `textTypeId` still selects by the type a label has now. An unknown posting is not-found.
 */
export async function listTexts(db: Db, opts: TextQuery = {}): Promise<TextAsset[]> {
  if (opts.postingId !== undefined) return listLinkedTexts(db, opts.postingId, opts.textTypeId)
  const newest = await readNewestPerLabel(db, opts.textTypeId)
  if (!opts.includeHistory || newest.length === 0) return newest
  return db
    .select()
    .from(textAsset)
    .where(inArray(textAsset.label, newest.map((row) => row.label)))
    .orderBy(asc(textAsset.label), desc(textAsset.version))
}

/** The versions linked to one posting, kept to the labels whose newest version has `textTypeId` when given. */
async function listLinkedTexts(db: Db, postingId: number, textTypeId: number | undefined): Promise<TextAsset[]> {
  await assertPostingExists(db, postingId)
  const linked = await db
    .select({ text: textAsset })
    .from(textAssetPosting)
    .innerJoin(textAsset, eq(textAsset.id, textAssetPosting.textAssetId))
    .where(eq(textAssetPosting.postingId, postingId))
    .orderBy(asc(textAsset.label), desc(textAsset.version))
  const rows = linked.map((row) => row.text)
  if (textTypeId === undefined || rows.length === 0) return rows
  const labelsOfType = new Set((await readNewestPerLabel(db, textTypeId)).map((row) => row.label))
  return rows.filter((row) => labelsOfType.has(row.label))
}

/** One version of a text, by id, or a not-found error naming it. */
async function assertTextExists(db: Db, textAssetId: number): Promise<void> {
  const [found] = await db.select({ id: textAsset.id }).from(textAsset).where(eq(textAsset.id, textAssetId))
  if (!found) throw new NotFoundError('text', textAssetId)
}

/**
 * Records that one version of a text was used for one posting, and returns the link. Linking
 * twice is a no-op that returns the first link, `linkedAt` included. An unknown text version or
 * posting is a not-found error.
 */
export async function linkText(db: Db, input: TextLinkInput): Promise<TextLink> {
  await assertTextExists(db, input.textAssetId)
  await assertPostingExists(db, input.postingId)
  const [created] = await db.insert(textAssetPosting).values(input).onConflictDoNothing().returning()
  if (created) return created

  const [existing] = await db
    .select()
    .from(textAssetPosting)
    .where(and(eq(textAssetPosting.textAssetId, input.textAssetId), eq(textAssetPosting.postingId, input.postingId)))
  if (!existing) throw new NotFoundError('text link', `${input.textAssetId} ${input.postingId}`)
  return existing
}
