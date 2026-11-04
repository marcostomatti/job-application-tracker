import { listPendingRescore, requestRescore } from '../../data/repositories/rescore.ts'
import { getBestScores, getScoreHistory } from '../../data/repositories/scores.ts'
import {
  PendingRescoreQuerySchema,
  PostingScoresQuerySchema,
  RescoreRequestInputSchema,
} from '../../schemas/scores.ts'
import { route, type RouteSpec } from './spec.ts'

/** The routes that read a posting's scores and ask for postings to be scored again. */
export const scoreRoutes: readonly RouteSpec[] = [
  route('get', '/postings/:postingId/scores', 'score_history', PostingScoresQuerySchema, async (args, db) =>
    getScoreHistory(db, args.postingId),
  ),
  route('get', '/postings/:postingId/best-scores', 'score_best', PostingScoresQuerySchema, async (args, db) =>
    getBestScores(db, args.postingId),
  ),
  route('post', '/rescore-requests', 'rescore_request', RescoreRequestInputSchema, async (args, db) =>
    requestRescore(db, args),
  ),
  route('get', '/rescore-requests/pending', 'rescore_pending', PendingRescoreQuerySchema, async (args, db) =>
    listPendingRescore(db, args.rescoreRequestId),
  ),
]
