import { z } from 'zod'

import { booleanOrText, hasNoNul, IdSchema, jsonHasNoNul, NO_NUL_MESSAGE } from './common.ts'
import { AnchorsSchema } from './scoring.ts'

/** Trimmed, non-empty and storable: a blank label says nothing, and NUL is refused. */
const requiredText = z.string().trim().min(1).refine(hasNoNul, NO_NUL_MESSAGE)

/**
 * What a coverage of 0, 0.5 and 1 mean for one requirement, as a caller may write it.
 * The shape is the pack schema's, so a requirement edited here holds the rubric a pack ships;
 * the NUL check is added because this one is a jsonb payload a caller types.
 */
export const RequirementAnchorsSchema = AnchorsSchema.refine(jsonHasNoNul, NO_NUL_MESSAGE)

export type Anchors = z.infer<typeof RequirementAnchorsSchema>

/** The requirement kinds, an internal discriminator the database also enumerates. */
export const REQUIREMENT_KINDS = ['gate', 'soft'] as const

export type RequirementKind = (typeof REQUIREMENT_KINDS)[number]

/**
 * A change to one requirement: the four columns a user edits, and no others. A weight is
 * finite and never negative (the database holds the same bound), `0` records a requirement
 * without scoring it, and `null` means no weight is set yet. An empty patch names nothing to
 * change, which is a mistake worth reporting.
 */
export const RequirementPatchSchema = z
  .strictObject({
    weight: z.number().min(0).nullable().optional(),
    kind: z.enum(REQUIREMENT_KINDS).optional(),
    label: requiredText.optional(),
    anchors: RequirementAnchorsSchema.optional(),
  })
  .refine((patch) => Object.values(patch).some((value) => value !== undefined), {
    message: 'a patch must name at least one field to change',
  })

export type RequirementPatch = z.infer<typeof RequirementPatchSchema>

/**
 * A request for the next version of a criteria set. The version number is never supplied:
 * it is the source's plus one, so two callers cannot disagree about what "next" means.
 * `name` renames the line of descent; left out, the copy keeps the source's name.
 */
export const CriteriaVersionInputSchema = z.strictObject({
  fromSetId: IdSchema,
  name: requiredText.optional(),
})

export type CriteriaVersionInput = z.infer<typeof CriteriaVersionInputSchema>

/** Which criteria sets a list returns; archived ones are left out unless asked for. */
export const CriteriaSetQuerySchema = z.strictObject({
  includeArchived: booleanOrText.optional(),
})

export type CriteriaSetQuery = z.infer<typeof CriteriaSetQuerySchema>
