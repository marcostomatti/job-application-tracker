import { getPosition, searchPositions, updatePosition } from '../../data/repositories/positions.ts'
import { listOrigins } from '../../data/repositories/provenance.ts'
import { getSummary } from '../../data/repositories/summaries.ts'
import { PositionQuerySchema, PositionRefSchema, PositionUpdateInputSchema } from '../../schemas/positions.ts'
import { route, type RouteSpec } from './spec.ts'

/** The routes that read and edit positions, and what is stored about one: its summary and its origins. */
export const positionRoutes: readonly RouteSpec[] = [
  route('get', '/positions', 'position_search', PositionQuerySchema, async (args, db) => searchPositions(db, args)),
  route('get', '/positions/:positionId', 'position_get', PositionRefSchema, async (args, db) =>
    getPosition(db, args.positionId),
  ),
  route('patch', '/positions/:positionId', 'position_update', PositionUpdateInputSchema, async (args, db) =>
    updatePosition(db, args.positionId, args.patch),
  ),
  route('get', '/positions/:positionId/summary', 'summary_get', PositionRefSchema, async (args, db) =>
    getSummary(db, args.positionId),
  ),
  route('get', '/positions/:positionId/origins', 'origin_list', PositionRefSchema, async (args, db) =>
    listOrigins(db, args.positionId),
  ),
]
