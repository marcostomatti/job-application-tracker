import { listPendingRescore, requestRescore } from '../../data/repositories/rescore.ts'
import { getBestScores, getScoreHistory } from '../../data/repositories/scores.ts'
import {
  PendingRescoreQuerySchema,
  PositionScoresQuerySchema,
  RescoreRequestInputSchema,
} from '../../schemas/scores.ts'
import { route, type RouteSpec } from './spec.ts'

/** The routes that read a position's scores and ask for positions to be scored again. */
export const scoreRoutes: readonly RouteSpec[] = [
  route('get', '/positions/:positionId/scores', 'score_history', PositionScoresQuerySchema, async (args, db) =>
    getScoreHistory(db, args.positionId),
  ),
  route('get', '/positions/:positionId/best-scores', 'score_best', PositionScoresQuerySchema, async (args, db) =>
    getBestScores(db, args.positionId),
  ),
  route('post', '/rescore-requests', 'rescore_request', RescoreRequestInputSchema, async (args, db) =>
    requestRescore(db, args),
  ),
  route('get', '/rescore-requests/pending', 'rescore_pending', PendingRescoreQuerySchema, async (args, db) =>
    listPendingRescore(db, args.rescoreRequestId),
  ),
]
