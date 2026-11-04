import { z } from 'zod'

import { booleanOrText, bulkOf, hasNoNul, IdSchema, NO_NUL_MESSAGE } from './common.ts'

/**
 * The name a text goes by, which is also what groups its versions: every version of a cover
 * letter carries the same label. Trimmed and non-empty, and free of NUL.
 */
const label = z.string().trim().min(1).refine(hasNoNul, NO_NUL_MESSAGE)

/**
 * The words of a text, kept exactly as written: the line breaks and indentation of a letter
 * belong to its author, so the body is not trimmed. It must say something, and it is the field
 * a pasted NUL byte is most likely to arrive in, so NUL is refused here with a field-level
 * message and not left to the database's driver error, which repeats the statement.
 */
const body = z
  .string()
  .refine((value) => value.trim().length > 0, 'must not be blank')
  .refine(hasNoNul, NO_NUL_MESSAGE)

/**
 * A new text, version 1. `textTypeId` is optional and nullable because the text type
 * registry ships empty, so a text may have no type.
 */
export const NewTextSchema = z.strictObject({
  label,
  body,
  textTypeId: IdSchema.nullable().optional(),
})

export type NewTextInput = z.infer<typeof NewTextSchema>

export const NewTextBulkSchema = bulkOf(NewTextSchema)

/**
 * A new version of an existing text, named by its label. `version` is not accepted: the
 * next number is the data layer's to assign. `textTypeId` absent keeps the type of the latest
 * version, a value changes it and null clears it.
 */
export const TextUpdateSchema = z.strictObject({
  label,
  body,
  textTypeId: IdSchema.nullable().optional(),
})

export type TextUpdateInput = z.infer<typeof TextUpdateSchema>

/**
 * Which texts to list: by default the latest version of each label, and with
 * `includeHistory` every version of the labels that match. `textTypeId` is judged on the
 * latest version of a label, because that is the type the text has now. With `postingId`, the
 * list is exactly the versions linked to that posting, so `includeHistory` changes nothing there.
 */
export const TextQuerySchema = z.strictObject({
  textTypeId: IdSchema.optional(),
  includeHistory: booleanOrText.optional(),
  postingId: IdSchema.optional(),
})

export type TextQuery = z.infer<typeof TextQuerySchema>

/** One version of a text, by its row id, and the posting it was used for. */
export const TextLinkInputSchema = z.strictObject({
  textAssetId: IdSchema,
  postingId: IdSchema,
})

export type TextLinkInput = z.infer<typeof TextLinkInputSchema>

/** Up to `BULK_MAX` links, all or none. */
export const TextLinkBulkSchema = bulkOf(TextLinkInputSchema)
