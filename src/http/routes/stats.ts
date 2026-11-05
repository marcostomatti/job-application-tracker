import { MarketStatsQuerySchema } from '../../schemas/stats.ts'
import { marketStats } from '../../mcp/tools/stats.ts'
import { route, type RouteSpec } from './spec.ts'

/** The stats page's one read, mirroring `market_stats`. */
export const statsRoutes: RouteSpec[] = [route('get', '/stats', 'market_stats', MarketStatsQuerySchema, (args, db) => marketStats(db, args))]
