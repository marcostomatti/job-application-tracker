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
