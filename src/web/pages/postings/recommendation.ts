/**
 * What a posting's recommendation looks like on screen, given the Settings display choice. Pure,
 * so the grid, the board and the detail panel agree and the rules are tested without a render.
 * Types only from the schema, so the web bundle does not pull in zod.
 */
import { BAND_LABELS } from '../../charts/options.ts'
import type { Recommendation, RecommendationDisplay, RulesBand } from '../../data.ts'

/** The display choices in Settings order, and the one used before the setting loads or when it cannot be read. */
export const RECOMMENDATION_DISPLAYS: readonly RecommendationDisplay[] = ['rules', 'agent', 'both']
export const DEFAULT_DISPLAY: RecommendationDisplay = 'both'

export type RecommendationSource = 'rules' | 'agent'


/** One band chip: the band, and which recommendation it comes from. */
export interface RecommendationChip {
  readonly band: RulesBand
  readonly source: RecommendationSource
}

export interface RecommendationView {
  /** The chip shown first; its band is what the band filter, the sort and the colours read. */
  readonly primary: RecommendationChip
  /** The agent's chip beside the rules one, under `both` when the agent gave a verdict. */
  readonly secondary: RecommendationChip | null
  /** True under `agent` when the agent gave no verdict, so the rules band stands in. */
  readonly fellBack: boolean
  /** True under `both` when the two recommendations differ. */
  readonly disagree: boolean
  /** The whole reading in words, the agent's reason included: a chip's tooltip and accessible name. */
  readonly label: string
}

const sentence = (source: RecommendationSource, band: RulesBand): string => `${source === 'rules' ? 'Rules' : 'Agent'}: ${BAND_LABELS[band]}`

function withReason(text: string, reason: string | null): string {
  return reason === null ? text : `${text} (${reason})`
}

/** What to show for one recommendation under one display choice. */
export function recommendationView(recommendation: Recommendation, display: RecommendationDisplay): RecommendationView {
  const { rules, agent } = recommendation
  const rulesChip: RecommendationChip = { band: rules, source: 'rules' }
  const reason = agent?.reason ?? null

  if (display === 'rules') {
    return { primary: rulesChip, secondary: null, fellBack: false, disagree: false, label: sentence('rules', rules) }
  }

  if (display === 'agent') {
    if (agent === null) {
      return { primary: rulesChip, secondary: null, fellBack: true, disagree: false, label: `${sentence('rules', rules)}. The agent gave no verdict.` }
    }
    return {
      primary: { band: agent.band, source: 'agent' },
      secondary: null,
      fellBack: false,
      disagree: false,
     
      label: withReason(sentence('agent', agent.band), reason),
    }
  }

  if (agent === null) {
    return { primary: rulesChip, secondary: null, fellBack: false, disagree: false, label: `${sentence('rules', rules)}. Agent: no verdict.` }
  }
  const disagree = recommendation.disagree
  const both = `${sentence('rules', rules)}. ${withReason(sentence('agent', agent.band), reason)}.`
  return {
    primary: rulesChip,
    secondary: { band: agent.band, source: 'agent' },
    fellBack: false,
    disagree,
   
    label: disagree ? `${both} They disagree.` : both,
  }
}

/** The band a row is filtered, sorted and coloured by: the primary chip's. */
export function primaryBand(recommendation: Recommendation, display: RecommendationDisplay): RulesBand {
  return recommendationView(recommendation, display).primary.band
}

const BAND_RANK: Readonly<Record<RulesBand, number | null>> = { apply: 3, ask: 2, skip: 1, unscored: null }

/** A band as a sort value, best first when descending; `unscored` is null, so it sorts last either way. */
export function bandRank(band: RulesBand): number | null {
  return BAND_RANK[band]
}
