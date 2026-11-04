import { listTexts } from '../../data/repositories/texts.ts'
import { TextQuerySchema } from '../../schemas/texts.ts'
import { route, type RouteSpec } from './spec.ts'

/** The route that lists the user's reusable texts. */
export const textRoutes: readonly RouteSpec[] = [
  route('get', '/texts', 'text_list', TextQuerySchema, async (args, db) => listTexts(db, args)),
]
