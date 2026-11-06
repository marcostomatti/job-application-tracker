import { AGENT_VERDICTS, type AgentVerdict, type AgentVerdictBand, type Recommendation } from '../schemas/recommendation.ts'
import { leadBand } from './bands.ts'

/** What the rules read of a stored score, besides its gates: the overall and the stored verdict of the set. */
export interface ScoredStanding {
  readonly overall: number | null
  readonly recommendApply: boolean
}

/** The recommendation of a posting with no score: unscored, no agent verdict, nothing to disagree about. */
export const NO_RECOMMENDATION: Recommendation = Object.freeze({ rules: 'unscored', agent: null, disagree: false })

/**
 * Both recommendations of one score. The rules band is `leadBand` with the real gate state and
 * the configured ask floor, so the board and the stats page group a posting the same way. The
 * agent verdict is carried as given.
 *
 * `disagree` compares two bands, so it needs both: a verdict beside an `unscored` rules band
 * (a score whose overall is null) is not a disagreement, because the rules have not said anything.
 */
export function recommendationOf(
  score: ScoredStanding | null,
  gateBlocked: boolean,
  askFloor: number,
  verdict: AgentVerdict | null,
): Recommendation {
  if (score === null) return NO_RECOMMENDATION
  // The soft coverages play no part in a band; `leadBand` takes the stats' whole score shape.
  const rules = leadBand({ overall: score.overall, recommendApply: score.recommendApply, gateBlocked, softCoverages: [] }, askFloor)
  const disagree = verdict !== null && rules !== 'unscored' && verdict.band !== rules
  return { rules, agent: verdict, disagree }
}

/**
 * A verdict from its two stored columns. No band is no verdict, and the reason is then ignored
 * (the CHECK keeps it null). A band outside `AGENT_VERDICTS` means the table's CHECK and the
 * constant have drifted apart, which is a broken invariant and throws rather than hiding the row's verdict.
 */
export function storedVerdictOf(band: string | null, reason: string | null): AgentVerdict | null {
  if (band === null) return null
  const found = AGENT_VERDICTS.find((candidate) => candidate === band)
  if (found === undefined) throw new Error('A stored score has an agent verdict the posting_score table does not allow.')
  return { band: found, reason }
}

/** The two `posting_score` columns a verdict is stored in; no verdict stores two nulls. */
export function verdictColumnsOf(verdict: AgentVerdict | null | undefined): {
  readonly agentVerdict: AgentVerdictBand | null
  readonly agentReason: string | null
} {
  return verdict == null ? { agentVerdict: null, agentReason: null } : { agentVerdict: verdict.band, agentReason: verdict.reason }
}
