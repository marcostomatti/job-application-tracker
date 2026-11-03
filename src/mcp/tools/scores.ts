import type { Db } from '../../data/repositories/db.ts'
import { moveIfRecommended, type StageEvent } from '../../data/repositories/dispositions.ts'
import { listPendingRescore, requestRescore } from '../../data/repositories/rescore.ts'
import { getBestScores, getScoreHistory, scorePosition, type ScoreRow } from '../../data/repositories/scores.ts'
import {
  PendingRescoreQuerySchema,
  PositionScoresQuerySchema,
  RescoreRequestInputSchema,
  ScorePositionBulkSchema,
  ScorePositionInputSchema,
  type ScorePositionInput,
} from '../../schemas/scores.ts'
import { inOneTransaction } from '../bulk.ts'
import { defineTool, type ToolDefinition } from '../register.ts'

/**
 * One scoring pass followed by the move rule, on the database it is given (a transaction, from
 * both callers). The one place §9.1's move fires, shared by the single and the bulk tool so the
 * two cannot disagree about when a position moves.
 */
async function scoreAndMove(db: Db, input: ScorePositionInput): Promise<{ score: ScoreRow; stageEvent: StageEvent | null }> {
  const score = await scorePosition(db, input)
  const stageEvent = await moveIfRecommended(db, { positionId: input.positionId, recommendApply: score.recommendApply })
  return { score, stageEvent }
}

/** §11.1 group 3: scoring positions against a criteria set, reading scores, and re-score requests. */
export const scoreTools: ToolDefinition[] = [
  defineTool({
    name: 'score_position',
    title: 'Score a position',
    description:
      'Scores ONE position against ONE criteria set from the ratings and penalties you give, and returns { score, stageEvent }. ' +
      'The score carries its overall value, floor, ceiling, the limiting requirement and recommendApply. ' +
      'If the score recommends applying and the position is not already applied, the position is also moved to the first open stage of the phase flagged shortlist, and stageEvent is that move; otherwise stageEvent is null, including when no shortlist phase exists. ' +
      'The score and the move are one atomic step. Scoring the same position and set again on the same day replaces that score; on a later day it adds a re-score. ' +
      'A rating needs a coverage from 0 to 1, or null for not rated; a requirement you do not rate counts as not rated. Get requirement ids from criteria_requirements.',
    input: ScorePositionInputSchema,
    run: async (args, db) => db.transaction(async (tx) => scoreAndMove(tx, args)),
  }),
  defineTool({
    name: 'score_history',
    title: 'Get the score history of a position',
    description:
      'Returns EVERY score ever stored for ONE position, across all criteria sets, newest first; each row carries its criteriaSetId, its limiting requirement key and recommendApply. ' +
      'Use this to see how a position\'s score changed over time. To see only the current standing under each set, use score_best, which keeps one row per set. ' +
      'An unscored position returns an empty list; an unknown position is a not-found error.',
    input: PositionScoresQuerySchema,
    run: async (args, db) => getScoreHistory(db, args.positionId),
  }),
  defineTool({
    name: 'score_best',
    title: 'Get the latest score per criteria set',
    description:
      'Returns the LATEST score of ONE position under each criteria set it was scored against, newest first: one row per set, which is what the "+n more scores" chip counts. ' +
      'Use this for the current standing in each rubric; use score_history for every score including superseded ones. ' +
      'An unscored position returns an empty list; an unknown position is a not-found error.',
    input: PositionScoresQuerySchema,
    run: async (args, db) => getBestScores(db, args.positionId),
  }),
  defineTool({
    name: 'rescore_request',
    title: 'Request a re-score',
    description:
      'Records that every position seen on or after sinceDate (YYYY-MM-DD) should be scored against one criteria set, and returns the request. ' +
      'Nothing is scored by this call: it only states the intent. Read what is still waiting with rescore_pending, then score each with score_position. ' +
      'An unknown set is a not-found error and an archived set is refused.',
    input: RescoreRequestInputSchema,
    run: async (args, db) => requestRescore(db, args),
  }),
  defineTool({
    name: 'rescore_pending',
    title: 'List positions waiting to be re-scored',
    description:
      'Lists the positions still waiting on a re-score request, as { rescoreRequestId, positionId, criteriaSetId } rows ordered by request then position. ' +
      'Give rescoreRequestId for one request, or leave it out for every request. A position drops off the list as soon as it is scored with score_position, so an empty list means the work is done. ' +
      'An unknown request id is a not-found error.',
    input: PendingRescoreQuerySchema,
    run: async (args, db) => listPendingRescore(db, args.rescoreRequestId),
  }),
  defineTool({
    name: 'score_position_bulk',
    title: 'Score several positions',
    description:
      'Scores up to 500 positions in one call, each item exactly as score_position takes it, and returns [{ score, stageEvent }] in the order given. ' +
      'Each item moves its own position to the shortlist phase when, and only when, its own score recommends applying and the position is not already applied. ' +
      'All or none: if any item fails, no score is stored, no position moves, and the error names the failing item by its index. ' +
      'Prefer this to repeated score_position calls when working through a re-score request from rescore_pending.',
    input: ScorePositionBulkSchema,
    run: async (args, db) => inOneTransaction(db, args.items, (tx, item) => scoreAndMove(tx, item)),
  }),
]
