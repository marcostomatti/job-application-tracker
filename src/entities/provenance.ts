import type { z } from 'zod'
import type { OriginSchema } from '../schemas/provenance.ts'

export type Origin = z.infer<typeof OriginSchema>
