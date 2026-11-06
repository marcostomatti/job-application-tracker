import { describe, expect, test } from 'bun:test'

import { bandRank, primaryBand, recommendationView } from '../../src/web/pages/postings/recommendation.ts'
import { recommendation } from './postings-fixtures.ts'

const agreeing = recommendation('apply', { band: 'apply', reason: null })
const disagreeing = recommendation('ask', { band: 'skip', reason: 'Too much on-call.' })
const rulesOnly = recommendation('skip')

describe('recommendationView under rules', () => {
  test('shows the rules band alone, with no source tag and no disagreement, even when the agent differs', () => {
    const view = recommendationView(disagreeing, 'rules')

    expect(view.primary).toEqual({ band: 'ask', source: 'rules' })
    expect(view.secondary).toBeNull()
    expect(view.disagree).toBe(false)
    expect(view.fellBack).toBe(false)
    expect(view.label).toBe('Rules: Ask')
  })
})

describe('recommendationView under agent', () => {
  test("shows the agent's verdict with its reason in the label", () => {
    const view = recommendationView(disagreeing, 'agent')

    expect(view.primary).toEqual({ band: 'skip', source: 'agent' })
    expect(view.secondary).toBeNull()
    expect(view.fellBack).toBe(false)
    expect(view.disagree).toBe(false)
    expect(view.label).toBe('Agent: Skip (Too much on-call.)')
  })

  test('falls back to the rules band, marked as rules, when the agent gave no verdict', () => {
    const view = recommendationView(rulesOnly, 'agent')

    expect(view.primary).toEqual({ band: 'skip', source: 'rules' })
    expect(view.fellBack).toBe(true)
    expect(view.label).toContain('The agent gave no verdict.')
  })
})

describe('recommendationView under both', () => {
  test('puts the rules first and the agent second, and flags a disagreement in words', () => {
    const view = recommendationView(disagreeing, 'both')

    expect(view.primary).toEqual({ band: 'ask', source: 'rules' })
    expect(view.secondary).toEqual({ band: 'skip', source: 'agent' })
    expect(view.disagree).toBe(true)
    expect(view.label).toBe('Rules: Ask. Agent: Skip (Too much on-call.). They disagree.')
  })

  test('an agreeing verdict shows both chips with no flag', () => {
    const view = recommendationView(agreeing, 'both')

    expect(view.secondary).toEqual({ band: 'apply', source: 'agent' })
    expect(view.disagree).toBe(false)
    expect(view.label).not.toContain('disagree')
  })

  test('with no agent verdict there is one chip, and the label says the agent gave none', () => {
    const view = recommendationView(rulesOnly, 'both')

    expect(view.secondary).toBeNull()
    expect(view.fellBack).toBe(false)
    expect(view.label).toBe('Rules: Skip. Agent: no verdict.')
  })
})

describe('primaryBand and bandRank', () => {
  test("the primary band follows the display: rules under both, the agent's under agent", () => {
    expect(primaryBand(disagreeing, 'both')).toBe('ask')
    expect(primaryBand(disagreeing, 'agent')).toBe('skip')
    expect(primaryBand(rulesOnly, 'agent')).toBe('skip')
  })

  test('apply ranks above ask above skip, and unscored has no rank', () => {
    expect(bandRank('apply')).toBeGreaterThan(bandRank('ask') ?? Infinity)
    expect(bandRank('ask')).toBeGreaterThan(bandRank('skip') ?? Infinity)
    expect(bandRank('unscored')).toBeNull()
  })
})
