import { z } from 'zod'

import { bulkOf, hasNoNul, IdSchema, NO_NUL_MESSAGE } from './common.ts'

/** Trimmed, non-empty and storable: a blank note says nothing, and NUL is refused. */
const note = z.string().trim().min(1).refine(hasNoNul, NO_NUL_MESSAGE)

/**
 * One move of one position. `stageId` is required but nullable, like a rating's coverage: the
 * stage registry ships empty, so an event with no stage is a real state of a fresh install, and
 * a caller who leaves the field out has most likely forgotten it. `occurredAt` arrives as an
 * ISO-8601 instant with its offset, because a bare local time says nothing about which
 * instant it is, and leaves the event dated when it is recorded when absent.
 */
export const StageEventInputSchema = z.strictObject({
  positionId: IdSchema,
  stageId: IdSchema.nullable(),
  occurredAt: z.iso
    .datetime({ offset: true })
    .transform((instant) => new Date(instant))
    .optional(),
  note: note.optional(),
})

export type StageEventInput = z.infer<typeof StageEventInputSchema>

export const StageEventBulkSchema = bulkOf(StageEventInputSchema)

/**
 * The user setting a lead aside, for a reason of their own. The reason is a row of the
 * set-aside registry, and it is required: that registry is the user's criteria, so a set-aside
 * with no reason would record nothing the criteria could learn from.
 */
export const SetAsideInputSchema = z.strictObject({
  positionId: IdSchema,
  setAsideReasonId: IdSchema,
  note: note.optional(),
})

export type SetAsideInput = z.infer<typeof SetAsideInputSchema>

/**
 * A rejection by the other side, with a reason from the rejection registry. A different
 * schema from the set-aside one on purpose: the two reasons come from different registries
 * and are never interchangeable, so one schema with a `kind` would make the wrong pairing
 * expressible.
 */
export const RecordRejectionInputSchema = z.strictObject({
  positionId: IdSchema,
  rejectionReasonId: IdSchema,
  note: note.optional(),
})

export type RecordRejectionInput = z.infer<typeof RecordRejectionInputSchema>
