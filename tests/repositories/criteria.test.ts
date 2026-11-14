import { describe, expect, test } from 'bun:test'

import {
  CriteriaSetQuerySchema,
  CriteriaVersionInputSchema,
  RequirementPatchSchema,
} from '../../src/schemas/criteria.ts'

describe('RequirementPatchSchema', () => {
  test('refuses a weight of Infinity at the schema', () => {
    expect(RequirementPatchSchema.safeParse({ weight: Infinity }).success).toBe(false)
    expect(RequirementPatchSchema.safeParse({ weight: -Infinity }).success).toBe(false)
  })

  test('refuses NaN, a negative weight and a weight that is text', () => {
    expect(RequirementPatchSchema.safeParse({ weight: Number.NaN }).success).toBe(false)
    expect(RequirementPatchSchema.safeParse({ weight: -1 }).success).toBe(false)
    expect(RequirementPatchSchema.safeParse({ weight: '2' }).success).toBe(false)
  })

  test('accepts null, zero and a finite weight', () => {
    expect(RequirementPatchSchema.safeParse({ weight: null }).success).toBe(true)
    expect(RequirementPatchSchema.safeParse({ weight: 0 }).success).toBe(true)
    expect(RequirementPatchSchema.safeParse({ weight: 3.5 }).success).toBe(true)
  })

  test('refuses a field it does not name, rather than dropping it', () => {
    expect(RequirementPatchSchema.safeParse({ weight: 1, importance: 5 }).success).toBe(false)
    expect(RequirementPatchSchema.safeParse({ layerId: 3 }).success).toBe(false)
  })

  test('refuses an empty patch, a kind outside gate and soft, and a blank label', () => {
    expect(RequirementPatchSchema.safeParse({}).success).toBe(false)
    expect(RequirementPatchSchema.safeParse({ kind: 'maybe' }).success).toBe(false)
    expect(RequirementPatchSchema.safeParse({ label: '   ' }).success).toBe(false)
  })

  test('refuses a NUL byte in the label and anywhere in the anchors', () => {
    expect(RequirementPatchSchema.safeParse({ label: 'a\u0000b' }).success).toBe(false)
    expect(RequirementPatchSchema.safeParse({ anchors: { '0': 'a\u0000', '0.5': 'b', '1': 'c' } }).success).toBe(false)
  })

  test('requires all three anchors, each non-empty, and no others', () => {
    expect(RequirementPatchSchema.safeParse({ anchors: { '0': 'a', '1': 'c' } }).success).toBe(false)
    expect(RequirementPatchSchema.safeParse({ anchors: { '0': 'a', '0.5': ' ', '1': 'c' } }).success).toBe(false)
    expect(RequirementPatchSchema.safeParse({ anchors: { '0': 'a', '0.5': 'b', '1': 'c', '2': 'd' } }).success).toBe(false)
  })
})

describe('the other criteria schemas', () => {
  test('a version input needs a source id, takes an optional name, and refuses NUL and unknown keys', () => {
    expect(CriteriaVersionInputSchema.parse({ fromSetId: '3' })).toEqual({ fromSetId: 3 })
    expect(CriteriaVersionInputSchema.parse({ fromSetId: 3, name: ' Next ' })).toEqual({ fromSetId: 3, name: 'Next' })
    expect(CriteriaVersionInputSchema.safeParse({ fromSetId: 3, name: 'a\u0000' }).success).toBe(false)
    expect(CriteriaVersionInputSchema.safeParse({ fromSetId: 3, name: '' }).success).toBe(false)
    expect(CriteriaVersionInputSchema.safeParse({ name: 'x' }).success).toBe(false)
    expect(CriteriaVersionInputSchema.safeParse({ fromSetId: 3, version: 9 }).success).toBe(false)
  })

  test('a set query takes includeArchived as a boolean or its text form, a scale, and nothing else', () => {
    expect(CriteriaSetQuerySchema.parse({})).toEqual({ scale: 'ratio' })
    expect(CriteriaSetQuerySchema.parse({ includeArchived: 'true', scale: 'stars' })).toEqual({ includeArchived: true, scale: 'stars' })
    expect(CriteriaSetQuerySchema.safeParse({ includeArchived: 'yes' }).success).toBe(false)
    expect(CriteriaSetQuerySchema.safeParse({ limit: 5 }).success).toBe(false)
  })
})
