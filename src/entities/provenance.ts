import type { z } from 'zod'
import type { OriginInputSchema, OriginSchema, SearchRunInputSchema } from '../schemas/provenance.ts'

export type Origin = z.infer<typeof OriginSchema>
export type NewOrigin = z.infer<typeof OriginInputSchema>
export type NewSearchRun = z.infer<typeof SearchRunInputSchema>
