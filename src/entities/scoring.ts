import type { z } from 'zod'
import type { DetourSchema, RatingSchema, RequirementSchema } from '../schemas/scoring.ts'

export type Requirement = z.infer<typeof RequirementSchema>
export type Rating = z.infer<typeof RatingSchema>
export type Detour = z.infer<typeof DetourSchema>
