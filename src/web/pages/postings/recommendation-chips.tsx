import { BAND_LABELS } from '../../charts/options.ts'
import type { RecommendationChip, RecommendationView } from './recommendation.ts'
import { SOURCE_LABELS } from './recommendation.ts'

function Chip({ chip, showSource, suffix }: { chip: RecommendationChip; showSource: boolean; suffix?: string }) {
  return (
    <span className={`band-chip band-${chip.band} rec-chip`}>
      <span className="dot" aria-hidden="true" />
      {showSource && <span className="rec-source">{SOURCE_LABELS[chip.source]}</span>}
      {BAND_LABELS[chip.band]}
      {suffix !== undefined && ` ${suffix}`}
    </span>
  )
}

/**
 * A posting's recommendation as band chips: one, or the rules and the agent side by side, each
 * naming its source in words and a disagreement marked in words too, so nothing rests on colour.
 * The whole reading, the agent's reason included, is the tooltip and what a screen reader hears.
 */
export function RecommendationChips({ view, suffix }: { view: RecommendationView; suffix?: string }) {
  return (
    <span className="rec-chips" title={view.label}>
      <span className="rec-chips-visible" aria-hidden="true">
        <Chip chip={view.primary} showSource={view.showSource} {...(suffix === undefined ? {} : { suffix })} />
        {view.secondary !== null && <Chip chip={view.secondary} showSource={view.showSource} />}
        {view.disagree && <span className="rec-disagree">disagree</span>}
      </span>
      <span className="rec-sr">
        {view.label}
        {suffix === undefined ? '' : ` Score ${suffix}.`}
      </span>
    </span>
  )
}
