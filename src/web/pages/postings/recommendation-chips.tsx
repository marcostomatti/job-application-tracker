import { BAND_LABELS } from '../../charts/options.ts'
import type { RecommendationChip, RecommendationView } from './recommendation.ts'

function Chip({ chip, suffix }: { chip: RecommendationChip; suffix?: string }) {
  return (
    <span className={`band-chip band-${chip.band} rec-chip`}>
      <span className="dot" aria-hidden="true" />
      {BAND_LABELS[chip.band]}
      {suffix !== undefined && ` ${suffix}`}
    </span>
  )
}

/**
 * A posting's recommendation as band chips: one, or the rules and then the agent side by side.
 * A chip shows only its band (and the score on the first), because a source tag on every row
 * pushed the band and the score out of a narrow cell. Which chip is which, and a disagreement,
 * are in words in the tooltip and in what a screen reader hears, so nothing rests on colour.
 * The whole reading, the agent's reason included, is the tooltip and what a screen reader hears.
 */
export function RecommendationChips({ view, suffix }: { view: RecommendationView; suffix?: string }) {
  return (
    <span className="rec-chips" title={view.label}>
      <span className="rec-chips-visible" aria-hidden="true">
        <Chip chip={view.primary} {...(suffix === undefined ? {} : { suffix })} />
        {view.secondary !== null && <Chip chip={view.secondary} />}
        {view.disagree && <span className="rec-disagree">disagree</span>}
      </span>
      <span className="rec-sr">
        {view.label}
        {suffix === undefined ? '' : ` Score ${suffix}.`}
      </span>
    </span>
  )
}
