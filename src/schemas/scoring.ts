import { z } from 'zod'

const unitInterval = z.number().min(0).max(1)

export const RequirementSchema = z.object({
  key: z.string(),
  layerKey: z.string(),
  kind: z.enum(['gate', 'soft']),
  // Never negative: 0 records a criterion without scoring it, null means none is set yet.
  weight: z.number().min(0).nullable(),
  label: z.string(),
})

export const RatingSchema = z.object({
  requirementKey: z.string(),
  // null means not rated, which is different from 0 (rated, and not covered).
  coverage: unitInterval.nullable(),
  confidence: z.enum(['supported', 'partial', 'unknown']),
})

export const DetourSchema = z.object({
  requirementKey: z.string(),
  label: z.string(),
  // The share of strength a detour gives up: 0 is as good as the direct route, 1 is worthless.
  discount: unitInterval,
  coverage: unitInterval.nullable(),
})

export const PenaltySchema = z.object({
  kindKey: z.string(),
  // A signed adjustment to the normalised score, never positive: -0.25 takes a quarter off.
  amount: z.number().max(0),
})

export const ScoreInputSchema = z.object({
  requirements: z.array(RequirementSchema),
  ratings: z.array(RatingSchema),
  detours: z.array(DetourSchema),
  penalties: z.array(PenaltySchema),
  // The overall a role must reach to be worth applying to; null until a bar has been set.
  // Bounded like the overall it is compared with, so a typo such as 1.5 cannot silently stop
  // every recommendation.
  applyThreshold: unitInterval.nullable(),
})

const nonEmptyText = z.string().trim().min(1)

/**
 * What a coverage of 0, 0.5 and 1 mean for one requirement. All three are required and
 * non-empty: an anchor-less requirement can only be read by whoever wrote it, which defeats
 * shipping the rubric. The database cannot say this (anchors is jsonb), so this is where it is held.
 */
export const AnchorsSchema = z.strictObject({
  '0': nonEmptyText,
  '0.5': nonEmptyText,
  '1': nonEmptyText,
})

/**
 * A pack is a file other people read, so its keys are snake_case like the columns they land
 * in, and every object is strict: an unknown key such as a hand-added "importance" would
 * otherwise be dropped unread. `weight` and `apply_threshold` accept only null, because a set
 * with weights is judgement by construction and the seed interview supplies them.
 */
export const PackRequirementSchema = z.strictObject({
  key: nonEmptyText,
  layer_key: nonEmptyText,
  kind: z.enum(['gate', 'soft']),
  weight: z.null(),
  label: nonEmptyText,
  anchors: AnchorsSchema,
})

export const PackLayerSchema = z.strictObject({
  key: nonEmptyText,
  label: nonEmptyText,
})

const duplicates = (values: readonly string[]): string[] =>
  values.filter((value, index) => values.indexOf(value) !== index)

export const VanillaPackSchema = z
  .strictObject({
    name: nonEmptyText,
    version: z.number().int().min(1),
    apply_threshold: z.null(),
    layers: z.array(PackLayerSchema),
    requirements: z.array(PackRequirementSchema).min(1),
  })
  .superRefine((pack, ctx) => {
    const layerKeys = pack.layers.map((entry) => entry.key)
    for (const key of duplicates(layerKeys)) {
      ctx.addIssue({ code: 'custom', path: ['layers'], message: `layer "${key}" is declared twice` })
    }
    for (const key of duplicates(pack.requirements.map((entry) => entry.key))) {
      ctx.addIssue({ code: 'custom', path: ['requirements'], message: `requirement "${key}" appears twice` })
    }
    pack.requirements.forEach((entry, index) => {
      if (!layerKeys.includes(entry.layer_key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['requirements', index, 'layer_key'],
          message: `layer "${entry.layer_key}" is not declared in the pack's layers`,
        })
      }
    })
  })
