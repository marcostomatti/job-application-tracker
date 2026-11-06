import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import type { CriteriaSetRow, RequirementRow } from '../../src/web/data.ts'
import { CriteriaView } from '../../src/web/pages/criteria.tsx'
import {
  anchorsOf,
  bandRules,
  detourEntries,
  initialSetId,
  setLabel,
  splitRequirements,
  thresholdText,
} from '../../src/web/pages/criteria-helpers.ts'

const noop = (): void => {}

const set = (overrides: Partial<CriteriaSetRow> & Pick<CriteriaSetRow, 'id'>): CriteriaSetRow => ({
  name: 'Example rubric',
  version: 1,
  createdAt: new Date('2026-02-01T10:00:00Z'),
  applyThreshold: 0.7,
  isDefault: false,
  archivedAt: null,
  ...overrides,
})

const ANCHORS = { '0': 'None of it', '0.5': 'Some of it', '1': 'All of it' }

const requirement = (overrides: Partial<RequirementRow> & Pick<RequirementRow, 'id' | 'key' | 'label'>): RequirementRow => ({
  criteriaSetId: 1,
  layerId: null,
  kind: 'soft',
  weight: null,
  anchors: ANCHORS,
  sort: 0,
  layerLabel: null,
  detours: [],
  ...overrides,
})

const SETS = [set({ id: 2, version: 2 }), set({ id: 1, isDefault: true, applyThreshold: null })]

const REQUIREMENTS: RequirementRow[] = [
  requirement({ id: 10, key: 'alpha', label: 'Alpha fit', weight: 3, layerLabel: 'Layer A' }),
  requirement({
    id: 11,
    key: 'beta',
    label: 'Beta fit',
    weight: 1,
    detours: [{ id: 50, requirementId: 11, label: 'Beta course', discount: 0.25, costAmount: '40', costUnit: 'hours' }],
  }),
  requirement({ id: 12, key: 'gamma', label: 'Gamma fit' }),
  requirement({ id: 13, key: 'gate_one', label: 'Example gate', kind: 'gate', weight: 9 }),
]

describe('criteria helpers', () => {
  test('the page opens on the default set, else the first listed', () => {
    expect(initialSetId(SETS)).toBe(1)
    expect(initialSetId([set({ id: 7 }), set({ id: 8 })])).toBe(7)
    expect(initialSetId([])).toBeUndefined()
  })

  test('a set label names the version and the default', () => {
    expect(setLabel(SETS[1] as CriteriaSetRow)).toBe('Example rubric v1 (default)')
    expect(setLabel(SETS[0] as CriteriaSetRow)).toBe('Example rubric v2')
  })

  test('weight shares divide by the positive soft weights only; a gate weight takes no part', () => {
    const split = splitRequirements(REQUIREMENTS)

    expect(split.weightTotal).toBe(4)
    expect(split.soft.map((row) => row.share)).toEqual([0.75, 0.25, null])
    expect(split.gates.map((row) => row.key)).toEqual(['gate_one'])
  })

  test('with no weight at all, no share is invented', () => {
    const split = splitRequirements([requirement({ id: 1, key: 'a', label: 'A', weight: 0 })])

    expect(split.weightTotal).toBe(0)
    expect(split.soft[0]?.share).toBeNull()
  })

  test('detours carry their requirement and a printed cost', () => {
    expect(detourEntries(REQUIREMENTS)).toEqual([{ requirementLabel: 'Beta fit', label: 'Beta course', discount: 0.25, cost: '40 hours' }])
  })

  test('anchors are read defensively', () => {
    expect(anchorsOf(ANCHORS).map((entry) => entry.point)).toEqual(['0', '0.5', '1'])
    expect(anchorsOf({ '0': 'Only zero', '1': 42 })).toEqual([{ point: '0', text: 'Only zero' }])
    expect(anchorsOf(null)).toEqual([])
  })

  test('the threshold prints as percent and stars, or as not set', () => {
    expect(thresholdText(0.7)).toBe('70% (3.5 stars)')
    expect(thresholdText(null)).toBe('not set')
  })

  test('band rules fill in the threshold and the ask floor', () => {
    const rules = bandRules(0.7, 0.5)

    expect(rules.map((rule) => rule.band)).toEqual(['apply', 'ask', 'skip', 'unscored'])
    expect(rules[0]?.rule).toContain('70%')
    expect(rules[1]?.rule).toContain('from 50% up to below 70%')
    expect(bandRules(null)[0]?.rule).toContain('no apply threshold')
  })
})

describe('CriteriaView', () => {
  test('shows the set picker, soft requirements with share bars, gates, detours and the glossary', () => {
    const html = renderToStaticMarkup(<CriteriaView sets={SETS} selectedId={2} onSelect={noop} requirements={REQUIREMENTS} />)

    expect(html).toContain('Example rubric v1 (default)')
    expect(html).toContain('70% (3.5 stars)')
    expect(html).toContain('width:75%')
    expect(html).toContain('not weighted')
    expect(html).toContain('Example gate')
    expect(html).toContain('Beta course')
    expect(html).toContain('costs 40 hours')
    expect(html).toContain('What 0, 0.5 and 1 mean')
    for (const word of ['Coverage', 'Weight', 'Gate', 'Detour', 'Penalty', 'Apply threshold', 'Apply', 'Ask', 'Skip', 'Unscored']) {
      expect(html).toContain(`>${word}<`)
    }
  })

  test('a set with no threshold and no requirements says so', () => {
    const html = renderToStaticMarkup(<CriteriaView sets={SETS} selectedId={1} onSelect={noop} requirements={[]} />)

    expect(html).toContain('not set')
    expect(html).toContain('No soft requirements in this set.')
    expect(html).toContain('No gates in this set')
    expect(html).toContain('No detours recorded')
  })

  test('requirements still loading, and no sets at all', () => {
    expect(renderToStaticMarkup(<CriteriaView sets={SETS} selectedId={1} onSelect={noop} requirements={undefined} />)).toContain('Loading the requirements')
    expect(renderToStaticMarkup(<CriteriaView sets={[]} selectedId={undefined} onSelect={noop} requirements={undefined} />)).toContain('No criteria sets yet.')
  })
})
