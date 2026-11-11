import { z } from 'zod'

import { ScaleSchema } from '../scoring/scale.ts'
import { booleanOrText, hasNoNul, IdSchema, jsonHasNoNul, NO_NUL_MESSAGE } from './common.ts'
import { REQUIREMENT_KINDS } from './discriminators.ts'
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
 * A request for a new version of a criteria set. The version number is never supplied: it is
 * one past the highest version that the target name already has, so two callers cannot
 * disagree about what "next" means. `fromSetId` says whose content is copied, not where the
 * number comes from, because the table records no parent. `name` picks the name the copy is
 * filed under; left out, it is the source's name. A name with no versions yet starts at v1,
 * so a renamed copy is v1 under the new name.
 */
export const CriteriaVersionInputSchema = z.strictObject({
  fromSetId: IdSchema,
  name: requiredText.optional(),
})

export type CriteriaVersionInput = z.infer<typeof CriteriaVersionInputSchema>

/** Which criteria sets a list returns, archived ones left out unless asked for, and the scale of their thresholds. */
export const CriteriaSetQuerySchema = z.strictObject({
  includeArchived: booleanOrText.optional(),
  scale: ScaleSchema,
})

export type CriteriaSetQuery = z.infer<typeof CriteriaSetQuerySchema>

/** The criteria set whose requirements a read returns. */
export const CriteriaRequirementsQuerySchema = z.strictObject({ criteriaSetId: IdSchema })

export type CriteriaRequirementsQuery = z.infer<typeof CriteriaRequirementsQuerySchema>

/** A patch and the requirement it applies to; the patch is a field of its own so the id is never mistaken for a column. */
export const RequirementUpdateInputSchema = z.strictObject({
  requirementId: IdSchema,
  patch: RequirementPatchSchema,
})

export type RequirementUpdateInput = z.infer<typeof RequirementUpdateInputSchema>

/**
 * A new requirement for one criteria set. The key and the anchors are required, because a
 * score names a requirement by its key and a weight means nothing without its rubric. `kind`
 * defaults to soft, a weight left out is not set yet (`null`), and `layerId` names a layer row.
 * The sort is never supplied: a new requirement goes after the ones the set already has.
 */
export const RequirementAddInputSchema = z.strictObject({
  criteriaSetId: IdSchema,
  key: requiredText,
  label: requiredText,
  kind: z.enum(REQUIREMENT_KINDS).optional(),
  weight: z.number().min(0).nullable().optional(),
  anchors: RequirementAnchorsSchema,
  layerId: IdSchema.nullable().optional(),
})

export type RequirementAddInput = z.infer<typeof RequirementAddInputSchema>

/** The criteria set to make the default. */
export const CriteriaSetDefaultInputSchema = z.strictObject({ criteriaSetId: IdSchema })

export type CriteriaSetDefaultInput = z.infer<typeof CriteriaSetDefaultInputSchema>
