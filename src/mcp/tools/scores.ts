import type { Db } from '../../data/repositories/db.ts'
import { moveIfRecommended, type StageEvent } from '../../data/repositories/dispositions.ts'
import { listPendingRescore, requestRescore } from '../../data/repositories/rescore.ts'
import { getBestScores, getScoreHistory, scorePosting, type ScoreRow } from '../../data/repositories/scores.ts'
import {
  PendingRescoreQuerySchema,
  PostingScoresQuerySchema,
  RescoreRequestInputSchema,
  ScorePostingBulkSchema,
  ScorePostingCallSchema,
  type PostingScoresQuery,
  type ScorePostingInput,
} from '../../schemas/scores.ts'
import { scaleScore, type Scale } from '../../scoring/scale.ts'
import { inOneTransaction } from '../bulk.ts'
import { defineTool, type ToolDefinition } from '../register.ts'

/**
 * One scoring pass followed by the move rule, on the database it is given (a transaction, from
 * both callers). The one place §9.1's move fires, shared by the single and the bulk tool so the
 * two cannot disagree about when a posting moves.
 */
async function scoreAndMove(db: Db, input: ScorePostingInput): Promise<{ score: ScoreRow; stageEvent: StageEvent | null }> {
  const score = await scorePosting(db, input)
  const stageEvent = await moveIfRecommended(db, { postingId: input.postingId, recommendApply: score.recommendApply })
  return { score, stageEvent }
}

type ScoredMove = Awaited<ReturnType<typeof scoreAndMove>>

/** A scoring answer with its score shown on `scale`; the move it caused is as stored. */
const scaleScoredMove = (result: ScoredMove, scale: Scale): ScoredMove => ({ ...result, score: scaleScore(result.score, scale) })

/** Every score of a posting on the scale asked for: what `score_history` and its route return. */
export async function readScoreHistory(db: Db, args: PostingScoresQuery): Promise<ScoreRow[]> {
  return (await getScoreHistory(db, args.postingId)).map((row) => scaleScore(row, args.scale))
}

/** The standing score per current set on the scale asked for: what `score_best` and its route return. */
export async function readBestScores(db: Db, args: PostingScoresQuery): Promise<ScoreRow[]> {
  return (await getBestScores(db, args.postingId)).map((row) => scaleScore(row, args.scale))
}

/** The sentence every final-score tool adds to its description about `scale`. */
const SCALE_NOTE =
  'Give scale (stars, percent or basic) to read overall, floor and ceiling on that scale instead of 0..1; recommendApply is always the stored verdict. '

/** §11.1 group 3: scoring postings against a criteria set, reading scores, and re-score requests. */
export const scoreTools: ToolDefinition[] = [
  defineTool({
    name: 'score_posting',
    title: 'Score a posting',
    description:
      'Scores ONE posting against ONE criteria set from the ratings and penalties you give, and returns { score, stageEvent }. ' +
      'The score carries its overall value, floor, ceiling, the limiting requirement and recommendApply. ' +
      'If the score recommends applying and the posting is not already applied, the posting is also moved to the first open stage of the phase flagged shortlist, and stageEvent is that move; otherwise stageEvent is null, including when no shortlist phase exists. ' +
      'The move follows THIS score only: a posting scored under a set that says no is not moved, even when another current set recommends it, so a posting can appear in the recommended filter (posting_search with recommendApply true, which looks across all current sets) without having been shortlisted. ' +
      'The score and the move are one atomic step. Scoring the same posting and set again on the same day replaces that score; on a later day it adds a re-score. ' +
      'A rating needs a coverage from 0 to 1, or null for not rated; a requirement you do not rate counts as not rated. Get requirement ids from criteria_requirements. ' +
      SCALE_NOTE,
    input: ScorePostingCallSchema,
    run: async ({ scale, ...input }, db) => scaleScoredMove(await db.transaction(async (tx) => scoreAndMove(tx, input)), scale),
  }),
  defineTool({
    name: 'score_history',
    title: 'Get the score history of a posting',
    description:
      'Returns EVERY score ever stored for ONE posting, across all criteria sets, newest first; each row carries its criteriaSetId, criteriaSetName, criteriaSetVersion, its limiting requirement key and recommendApply. ' +
      'Use this to see how a posting\'s score changed over time. To see only the standing that counts today, use score_best, which keeps one row per current set. ' +
      'An unscored posting returns an empty list; an unknown posting is a not-found error. ' +
      SCALE_NOTE,
    input: PostingScoresQuerySchema,
    run: async (args, db) => readScoreHistory(db, args),
  }),
  defineTool({
    name: 'score_best',
    title: 'Get the latest score per criteria set',
    description:
      'Returns the scores that stand today for ONE posting, newest first: the LATEST score under each current criteria set, where current means the highest version of a set name. ' +
      'One row per set name, which is what the "+n more scores" chip counts; each row carries criteriaSetName and criteriaSetVersion, and a score under an older version of a name is left out. ' +
      'A posting is recommended for apply when at least one of these rows has recommendApply true. ' +
      'Use this for the current standing in each rubric; use score_history for every score including superseded ones. ' +
      'An unscored posting returns an empty list; an unknown posting is a not-found error. ' +
      SCALE_NOTE,
    input: PostingScoresQuerySchema,
    run: async (args, db) => readBestScores(db, args),
  }),
  defineTool({
    name: 'rescore_request',
    title: 'Request a re-score',
    description:
      'Records that every posting seen on or after sinceDate (YYYY-MM-DD) should be scored against one criteria set, and returns the request. ' +
      'Nothing is scored by this call: it only states the intent. Read what is still waiting with rescore_pending, then score each with score_posting. ' +
      'An unknown set is a not-found error and an archived set is refused.',
    input: RescoreRequestInputSchema,
    run: async (args, db) => requestRescore(db, args),
  }),
  defineTool({
    name: 'rescore_pending',
    title: 'List postings waiting to be re-scored',
    description:
      'Lists the postings still waiting on a re-score request, as { rescoreRequestId, postingId, criteriaSetId } rows ordered by request then posting. ' +
      'Give rescoreRequestId for one request, or leave it out for every request. A posting drops off the list as soon as it is scored with score_posting, so an empty list means the work is done. ' +
      'An unknown request id is a not-found error.',
    input: PendingRescoreQuerySchema,
    run: async (args, db) => listPendingRescore(db, args.rescoreRequestId),
  }),
  defineTool({
    name: 'score_posting_bulk',
    title: 'Score several postings',
    description:
      'Scores up to 500 postings in one call, each item exactly as score_posting takes it, and returns [{ score, stageEvent }] in the order given. ' +
      'Each item moves its own posting to the shortlist phase when, and only when, its own score recommends applying and the posting is not already applied. ' +
      'All or none: if any item fails, no score is stored, no posting moves, and the error names the failing item by its index. ' +
      'Prefer this to repeated score_posting calls when working through a re-score request from rescore_pending. ' +
      'One scale, outside items, applies to every answer of the call. ' +
      SCALE_NOTE,
    input: ScorePostingBulkSchema,
    run: async (args, db) =>
      (await inOneTransaction(db, args.items, (tx, item) => scoreAndMove(tx, item))).map((result) =>
        scaleScoredMove(result, args.scale),
      ),
  }),
]
