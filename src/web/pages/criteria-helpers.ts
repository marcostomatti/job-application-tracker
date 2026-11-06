import { DEFAULT_ASK_FLOOR } from '../../stats/bands.ts'
import type { CriteriaSetRow, RequirementRow } from '../data.ts'

/** The anchor points a requirement's rubric names, in order. */
export const ANCHOR_POINTS = ['0', '0.5', '1'] as const

/** The set the page opens on: the default one, else the newest (the server lists newest first). */
export function initialSetId(sets: readonly CriteriaSetRow[]): number | undefined {
  return (sets.find((set) => set.isDefault) ?? sets[0])?.id
}

/** A set as a select option names it: name, version, and whether it is the default. */
export function setLabel(set: Pick<CriteriaSetRow, 'name' | 'version' | 'isDefault'>): string {
  return `${set.name} v${set.version}${set.isDefault ? ' (default)' : ''}`
}

/** A 0..1 value as a whole percent. */
export function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`
}

/** A 0..1 value on the five-star scale, one decimal. */
export function stars(ratio: number): string {
  return `${(Math.round(ratio * 50) / 10).toFixed(1)} stars`
}

/** The apply threshold as the page prints it; null is a set with no bar yet. */
export function thresholdText(threshold: number | null): string {
  return threshold === null ? 'not set' : `${percent(threshold)} (${stars(threshold)})`
}

/** A soft requirement and its share of the set's weight total; null when it has no weight yet. */
export interface WeightedRow {
  readonly requirement: RequirementRow
  readonly share: number | null
}

export interface SplitRequirements {
  readonly soft: readonly WeightedRow[]
  readonly gates: readonly RequirementRow[]
  /** The sum of the positive soft weights, which the overall divides by. */
  readonly weightTotal: number
}

const positiveWeight = (row: RequirementRow): number => (row.weight !== null && row.weight > 0 ? row.weight : 0)

/**
 * Soft requirements with their weight shares, and gates, each in rubric order. Only soft
 * requirements with a positive weight count toward the total, which is what the overall
 * normalises by; a gate's weight takes no part.
 */
export function splitRequirements(rows: readonly RequirementRow[]): SplitRequirements {
  const softRows = rows.filter((row) => row.kind === 'soft')
  const weightTotal = softRows.reduce((sum, row) => sum + positiveWeight(row), 0)
  const soft = softRows.map((requirement) => ({
    requirement,
    share: requirement.weight === null || weightTotal === 0 ? null : positiveWeight(requirement) / weightTotal,
  }))
  return { soft, gates: rows.filter((row) => row.kind === 'gate'), weightTotal }
}

/** One detour with the requirement it goes round. */
export interface DetourEntry {
  readonly requirementLabel: string
  readonly label: string
  readonly discount: number
  readonly cost: string | null
}

/** Every detour of the set, in rubric order, its cost printed when one is recorded. */
export function detourEntries(rows: readonly RequirementRow[]): DetourEntry[] {
  return rows.flatMap((row) =>
    row.detours.map((detour) => ({
      requirementLabel: row.label,
      label: detour.label,
      discount: detour.discount,
      cost: detour.costAmount === null ? null : [detour.costAmount, detour.costUnit].filter((part) => part !== null).join(' '),
    })),
  )
}

/**
 * What a coverage of 0, 0.5 and 1 mean for a requirement. `anchors` is jsonb, so it is read
 * defensively: a point missing or not text is left out rather than printed as garbage.
 */
export function anchorsOf(anchors: unknown): { point: string; text: string }[] {
  if (typeof anchors !== 'object' || anchors === null) return []
  const record = anchors as Record<string, unknown>
  return ANCHOR_POINTS.flatMap((point) => {
    const text = record[point]
    return typeof text === 'string' && text.trim() !== '' ? [{ point, text }] : []
  })
}

/** One lead band and the rule that puts a posting in it. */
export interface BandRule {
  readonly band: 'apply' | 'ask' | 'skip' | 'unscored'
  readonly label: string
  readonly rule: string
}

/**
 * The apply, ask, skip and unscored bands in words, with this set's threshold and the ask floor
 * filled in. It follows `leadBand` in src/stats/bands.ts; the floor is the default unless a
 * caller knows the configured one.
 */
export function bandRules(threshold: number | null, askFloor: number = DEFAULT_ASK_FLOOR): BandRule[] {
  const floor = percent(askFloor)
  return [
    {
      band: 'apply',
      label: 'Apply',
      rule:
        threshold === null
          ? 'Nothing is recommended yet, because this set has no apply threshold.'
          : `Overall at or above ${percent(threshold)} with every gate open.`,
    },
    {
      band: 'ask',
      label: 'Ask',
      rule:
        threshold === null
          ? `Overall at or above ${floor}: worth asking questions before deciding.`
          : `Overall from ${floor} up to below ${percent(threshold)}: worth asking questions before deciding.`,
    },
    { band: 'skip', label: 'Skip', rule: `A closed gate, or an overall below ${floor}.` },
    { band: 'unscored', label: 'Unscored', rule: 'Not scored against this set, or no weighted requirement was rated.' },
  ]
}
