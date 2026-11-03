import type { z } from 'zod'
import type { NewOriginSchema, NewSearchRunSchema, OriginSchema } from '../schemas/provenance.ts'

export type Origin = z.infer<typeof OriginSchema>
export type NewOrigin = z.input<typeof NewOriginSchema>
export type NewSearchRun = z.input<typeof NewSearchRunSchema>
