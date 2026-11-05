import { SCALES } from '../scoring/scale.ts'
import type { MarketStats } from './types.ts'

const percent = (ratio: number): string => `${Math.round(ratio * 100)}%`

function scaleUnit(stats: MarketStats): string {
  return stats.scale === 'ratio' ? '' : ` of ${SCALES[stats.scale].max}`
}

/**
 * A short plain-text reading of the aggregates, for an agent that will propose what to chart
 * next. It states counts and their n, and names what is not recorded; it draws no conclusion
 * the numbers do not hold.
 */
export function readStats(stats: MarketStats): string {
  const { bands, criteriaSet } = stats
  const lines: string[] = []
  lines.push(
    `${stats.postings} postings against "${criteriaSet.name}" v${criteriaSet.version}: ` +
      `${bands.apply} apply, ${bands.ask} ask, ${bands.skip} skip, ${bands.unscored} unscored ` +
      `(ask starts at ${stats.bandEdges.askFloor}${scaleUnit(stats)}` +
      (stats.bandEdges.applyThreshold === null ? '; the set has no apply threshold, so nothing is recommended).' : `, apply at ${stats.bandEdges.applyThreshold}${scaleUnit(stats)}).`),
  )

  const topSource = stats.bySource[0]
  if (topSource) lines.push(`Most postings came from ${topSource.source} (${topSource.total}, ${topSource.bands.apply} apply).`)

  const { requirements } = stats
  const label = (key: string | null): string | undefined => requirements.rows.find((row) => row.key === key)?.label
  const struggling = requirements.rows.find((row) => row.key === requirements.struggling)
  const easiest = requirements.rows.find((row) => row.key === requirements.easiest)
  if (struggling?.averageCoverage != null) {
    lines.push(`Struggling most: ${label(struggling.key)} at ${percent(struggling.averageCoverage)} average coverage (n=${struggling.rated}).`)
  }
  if (easiest?.averageCoverage != null) {
    lines.push(`Most easily met: ${label(easiest.key)} at ${percent(easiest.averageCoverage)} (n=${easiest.rated}).`)
  }
  const unranked = requirements.rows.filter((row) => row.tooFew).length
  if (unranked > 0) lines.push(`${unranked} soft requirement(s) have fewer than ${stats.minN} ratings and are not ranked.`)

  const topStack = stats.byStack.rows.slice(0, 3).map((row) => `${row.label} (${row.count})`)
  if (topStack.length > 0) lines.push(`Top stack tags: ${topStack.join(', ')}; ${stats.byStack.notRecorded} postings have no stack recorded.`)
  else lines.push('No summary records a stack yet.')

  const topIndustry = stats.byIndustry.rows[0]
  lines.push(topIndustry ? `Most common industry: ${topIndustry.label} (${topIndustry.count}); ${stats.byIndustry.notRecorded} not recorded.` : 'No summary records an industry yet.')

  const years = stats.loose.yearsExperience
  lines.push(years.n === 0 ? 'No summary records years of experience (`extra.years_experience`).' : `Years of experience asked: average ${years.average}, median ${years.median} (n=${years.n}${years.tooFew ? ', too few to say' : ''}).`)

  if (stats.byStage.noStage < stats.postings) {
    const furthest = stats.byStage.rows.at(-1)
    if (furthest) lines.push(`${stats.postings - stats.byStage.noStage} postings have a stage; the furthest stage any is at now is ${furthest.stage} (${furthest.count}).`)
  }
  return lines.join('\n')
}
