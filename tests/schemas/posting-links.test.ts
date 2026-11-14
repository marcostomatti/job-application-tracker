import { describe, expect, test } from 'bun:test'

import { linkFromKey, PostingLinkPatternsSchema } from '../../src/schemas/posting-links.ts'

const PATTERNS = [{ prefix: 'board', template: 'https://jobs.example.test/view/{id}/' }]

describe('PostingLinkPatternsSchema', () => {
  test('takes a prefix and a web address holding {id}', () => {
    expect(PostingLinkPatternsSchema.parse(PATTERNS)).toEqual(PATTERNS)
    expect(PostingLinkPatternsSchema.parse([])).toEqual([])
  })

  test('refuses a template without {id}, one that is not a web address, and a script', () => {
    for (const template of ['https://jobs.example.test/view/', 'ftp://jobs.example.test/{id}', 'javascript:alert({id})', '/view/{id}']) {
      expect(PostingLinkPatternsSchema.safeParse([{ prefix: 'board', template }]).success).toBe(false)
    }
  })

  test('refuses a prefix with a colon or a space, a prefix named twice, and an unknown field', () => {
    expect(PostingLinkPatternsSchema.safeParse([{ prefix: 'bo:ard', template: PATTERNS[0]?.template }]).success).toBe(false)
    expect(PostingLinkPatternsSchema.safeParse([{ prefix: 'bo ard', template: PATTERNS[0]?.template }]).success).toBe(false)
    expect(PostingLinkPatternsSchema.safeParse([...PATTERNS, ...PATTERNS]).success).toBe(false)
    expect(PostingLinkPatternsSchema.safeParse([{ ...PATTERNS[0], label: 'x' }]).success).toBe(false)
  })
})

describe('linkFromKey', () => {
  test('fills {id} with what follows the prefix and its colon', () => {
    expect(linkFromKey('board:12345', PATTERNS)).toBe('https://jobs.example.test/view/12345/')
  })

  test('encodes the id, so it cannot change the address around it', () => {
    expect(linkFromKey('board:a/b?c=d', PATTERNS)).toBe('https://jobs.example.test/view/a%2Fb%3Fc%3Dd/')
  })

  test('a key with another prefix, no prefix or an empty id has no link', () => {
    expect(linkFromKey('other:12345', PATTERNS)).toBeNull()
    expect(linkFromKey('12345', PATTERNS)).toBeNull()
    expect(linkFromKey('board:', PATTERNS)).toBeNull()
    expect(linkFromKey('board:12345', [])).toBeNull()
  })

  test('the prefix matches without regard to case', () => {
    expect(linkFromKey('Board:7', PATTERNS)).toBe('https://jobs.example.test/view/7/')
  })
})
