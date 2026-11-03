import type { z } from 'zod'
import type {
  DetourSchema,
  PenaltySchema,
  RatingSchema,
  RequirementSchema,
  ScoreInputSchema,
} from '../schemas/scoring.ts'

export type Requirement = z.infer<typeof RequirementSchema>
export type Rating = z.infer<typeof RatingSchema>
export type Detour = z.infer<typeof DetourSchema>
export type Penalty = z.infer<typeof PenaltySchema>
export type ScoreInput = z.infer<typeof ScoreInputSchema>
