import { z } from 'zod'

import { PostingLinkPatternsSchema } from './posting-links.ts'

/**
 * The two recommendations a posting can carry, and which of them the app shows.
 *
 * - The RULES recommendation is computed by the server from the latest score: the stored
 *   `recommendApply`, the gates, and the configured ask floor (`leadBand` in `src/stats/bands.ts`).
 *   It is never stored, so it cannot drift from the score it reads.
 * - The AGENT recommendation is a verdict the agent writes next to a score, with a short reason.
 *   It belongs to the score it was given with: a new criteria version, and so a new score, starts
 *   without one until the agent gives it again.
 */

/** The verdicts an agent may give. `unscored` is a rules-only band, never an agent verdict. */
export const AGENT_VERDICTS = ['apply', 'ask', 'skip'] as const

export const AgentVerdictBandSchema = z.enum(AGENT_VERDICTS)

export type AgentVerdictBand = z.infer<typeof AgentVerdictBandSchema>

/** The longest reason an agent may store; one or two sentences, not a report. */
export const AGENT_REASON_MAX = 500

/** What the agent writes: a verdict and, optionally, why. */
export const AgentVerdictSchema = z.strictObject({
  band: AgentVerdictBandSchema,
  reason: z.string().trim().min(1).max(AGENT_REASON_MAX).nullable().default(null),
})

export type AgentVerdict = z.infer<typeof AgentVerdictSchema>

/** Which recommendation the board, the grid and the detail panel show. */
export const RECOMMENDATION_DISPLAYS = ['rules', 'agent', 'both'] as const

export const RecommendationDisplaySchema = z.enum(RECOMMENDATION_DISPLAYS)

export type RecommendationDisplay = z.infer<typeof RecommendationDisplaySchema>

/** What the app shows when nothing is stored: both, so a disagreement is visible by default. */
export const DEFAULT_RECOMMENDATION_DISPLAY: RecommendationDisplay = 'both'

/** The `app_config` key the display choice is stored under. */
export const RECOMMENDATION_DISPLAY_KEY = 'recommendation_display'

/** The rules band of a row: an agent verdict plus `unscored`. */
export type RulesBand = AgentVerdictBand | 'unscored'

/**
 * Both recommendations of one posting's latest score, as a list row and the detail carry them.
 * `agent` is null when the agent gave no verdict on that score. `disagree` is true only when
 * both exist and differ.
 */
export interface Recommendation {
  readonly rules: RulesBand
  readonly agent: AgentVerdict | null
  readonly disagree: boolean
}

/** The settings the web Settings page reads and writes. */
export const AppSettingsSchema = z.strictObject({
  askFloor: z.number().min(0).max(1),
  recommendationDisplay: RecommendationDisplaySchema,
  /** How a posting key becomes a link to the posting, per key prefix; empty means none. */
  postingLinkPatterns: PostingLinkPatternsSchema,
})

export type AppSettings = z.infer<typeof AppSettingsSchema>

/** A change to the settings: any of the fields, never none. */
export const AppSettingsPatchSchema = AppSettingsSchema.partial().refine(
  (patch) => Object.values(patch).some((value) => value !== undefined),
  { message: 'a patch must name at least one setting to change' },
)

export type AppSettingsPatch = z.infer<typeof AppSettingsPatchSchema>
