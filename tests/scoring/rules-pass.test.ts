import { describe, expect, test } from 'bun:test'

import { rulesFindings, titleHolds, type RulesPosting } from '../../src/scoring/rules-pass.ts'
import { RequirementRulesSchema } from '../../src/schemas/requirement-rules.ts'

const POSTING: RulesPosting = { roleTitle: 'Senior Backend Engineer', country: 'XA', city: 'Example City', workFormat: 'Hybrid' }

const gate = (rules: unknown) => [{ id: 7, key: 'example_gate', rules }]

describe('titleHolds', () => {
  test('finds a term as a whole word, case aside', () => {
    expect(titleHolds('Senior Backend Engineer', 'backend')).toBe(true)
    expect(titleHolds('Engineer, Example Framework', 'example framework')).toBe(true)
  })

  test('does not fire inside a longer word', () => {
    expect(titleHolds('Scriptwriter', 'script')).toBe(false)
    expect(titleHolds('Langscript Developer', 'lang')).toBe(false)
  })

  test('a term with punctuation still matches where it stands alone', () => {
    expect(titleHolds('Senior C# Developer', 'c#')).toBe(true)
    expect(titleHolds('Node.js Engineer', 'node.js')).toBe(true)
    expect(titleHolds('Student / Intern', 'intern')).toBe(true)
  })

  test('an empty term matches nothing', () => {
    expect(titleHolds('Engineer', '  ')).toBe(false)
  })
})

describe('rulesFindings', () => {
  test('a title term rates its requirement 0 and names the term', () => {
    const found = rulesFindings({ ...POSTING, roleTitle: 'Example Framework Developer' }, gate({ titleBlocks: ['example framework'] }))

    expect(found).toEqual([{ requirementId: 7, requirementKey: 'example_gate', evidence: 'rules pass: the title holds "example framework"' }])
  })

  test('a place the posting matches by every field it names rates nothing', () => {
    expect(rulesFindings(POSTING, gate({ place: [{ country: 'xa' }] }))).toEqual([])
    expect(rulesFindings(POSTING, gate({ place: [{ country: 'XB' }, { city: 'example city', workFormat: 'hybrid' }] }))).toEqual([])
  })

  test('a posting whose known fields match no allowed place is rated 0, with its place in the evidence', () => {
    const found = rulesFindings(POSTING, gate({ place: [{ country: 'XB' }, { country: 'XA', workFormat: 'Remote' }] }))

    expect(found.map((finding) => finding.evidence)).toEqual(['rules pass: country XA, city Example City, work format Hybrid matches no allowed place'])
  })

  test('a field the posting lacks leaves the place open, so nothing is rated', () => {
    const noFormat = { ...POSTING, workFormat: null }

    expect(rulesFindings(noFormat, gate({ place: [{ country: 'XA', workFormat: 'Remote' }] }))).toEqual([])
    expect(rulesFindings({ ...noFormat, country: null }, gate({ place: [{ country: 'XB' }] }))).toEqual([])
  })

  test('a known mismatch on one field decides, even when another field is missing', () => {
    const found = rulesFindings({ ...POSTING, workFormat: null }, gate({ place: [{ country: 'XB', workFormat: 'Remote' }] }))

    expect(found).toHaveLength(1)
  })

  test('requirements without rules, or with rules that do not parse, rate nothing', () => {
    const requirements = [
      { id: 1, key: 'none', rules: null },
      { id: 2, key: 'broken', rules: { titleBlocks: 'not a list' } },
      { id: 3, key: 'fires', rules: { titleBlocks: ['backend'] } },
    ]

    expect(rulesFindings(POSTING, requirements).map((finding) => finding.requirementKey)).toEqual(['fires'])
  })
})

describe('RequirementRulesSchema', () => {
  test('takes title terms, places, or both', () => {
    expect(RequirementRulesSchema.safeParse({ titleBlocks: ['a term'] }).success).toBe(true)
    expect(RequirementRulesSchema.safeParse({ place: [{ country: 'XA' }, { workFormat: 'Remote' }] }).success).toBe(true)
  })

  test('refuses empty rules, an empty place, an empty list, a blank term and an unknown field', () => {
    for (const rules of [{}, { place: [{}] }, { titleBlocks: [] }, { titleBlocks: ['  '] }, { titleBlocks: ['a'], weight: 1 }]) {
      expect(RequirementRulesSchema.safeParse(rules).success).toBe(false)
    }
  })
})
