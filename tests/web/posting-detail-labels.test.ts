import { describe, expect, test } from 'bun:test'

import {
  breakdownRows,
  dateInputToInstant,
  dispositionLabel,
  formatDay,
  formatOverall,
  formatPenalty,
  formatPercent,
  formatWeight,
  gateState,
  latestScore,
  locationLine,
  postingLink,
  scoreBand,
  trimmedOrUndefined,
} from '../../src/web/pages/postings/detail-labels.ts'
import { detailFixture, REQUIREMENTS } from './posting-detail-fixtures.ts'

describe('format helpers', () => {
  test('formatDay reads strings and Dates, and a missing day is a dash', () => {
    expect(formatDay('2026-10-05T12:00:00.000Z')).toBe('2026-10-05')
    expect(formatDay(new Date('2026-01-02T03:00:00.000Z'))).toBe('2026-01-02')
    expect(formatDay(null)).toBe('—')
    expect(formatDay('not a date')).toBe('not a date')
  })

  test('a null ratio is not measured and never reads as 0%', () => {
    expect(formatPercent(null)).toBe('—')
    expect(formatPercent(0)).toBe('0%')
    expect(formatPercent(0.625)).toBe('63%')
  })

  test('the overall reads as stars and percent, and null as not scored', () => {
    expect(formatOverall(0.62)).toBe('3.1 / 5 (62%)')
    expect(formatOverall(null)).toBe('not scored')
  })

  test('weights, penalties and locations', () => {
    expect(formatWeight(null)).toBe('—')
    expect(formatWeight(1.5)).toBe('1.5')
    expect(formatPenalty(-0.05)).toBe('−0.05')
    expect(formatPenalty(0)).toBe('0.00')
    expect(locationLine('Sampleton', null)).toBe('Sampleton')
    expect(locationLine(' ', null)).toBeNull()
    expect(locationLine('Sampleton', 'Exampleland')).toBe('Sampleton, Exampleland')
  })

  test('blank text is undefined, other text is trimmed', () => {
    expect(trimmedOrUndefined('   ')).toBeUndefined()
    expect(trimmedOrUndefined(' note ')).toBe('note')
  })

  test('a date input becomes an ISO instant on the same day; anything else is undefined', () => {
    const instant = dateInputToInstant('2026-10-05')
    expect(instant).toMatch(/^2026-10-0[45]T/)
    expect(new Date(instant!).getDate()).toBe(5)
    expect(dateInputToInstant('')).toBeUndefined()
    expect(dateInputToInstant('05/10/2026')).toBeUndefined()
  })

  test('disposition kinds read as words, an unknown kind as stored', () => {
    expect(dispositionLabel('set_aside')).toBe('Set aside')
    expect(dispositionLabel('rejected')).toBe('Rejected')
    expect(dispositionLabel('other_kind')).toBe('other_kind')
  })
})

describe('postingLink', () => {
  test("the summary's url is the link when the key is not one", () => {
    const extra = { url: 'https://jobs.example.test/42' }
    expect(postingLink({ postingKey: 'board:42', applyContact: 'jobs@example.test' }, extra)).toEqual({ href: 'https://jobs.example.test/42', label: 'Open posting' })
  })

  test('a summary extra saved as JSON text is read like the object it holds', () => {
    expect(postingLink({ postingKey: 'board:42', applyContact: null }, JSON.stringify({ url: 'https://jobs.example.test/42' }))?.href).toBe('https://jobs.example.test/42')
  })

  test('a url that is not a web address, or an extra that is not an object, adds no link', () => {
    expect(postingLink({ postingKey: 'board:42', applyContact: null }, { url: 'javascript:alert(1)' })).toBeNull()
    expect(postingLink({ postingKey: 'board:42', applyContact: null }, 'not json')).toBeNull()
    expect(postingLink({ postingKey: 'board:42', applyContact: null }, ['https://jobs.example.test/42'])).toBeNull()
  })

  test('a web posting key is the link', () => {
    expect(postingLink({ postingKey: 'https://jobs.example.test/1', applyContact: null })).toEqual({ href: 'https://jobs.example.test/1', label: 'Open posting' })
  })

  test('without one, a web or email apply contact is the link', () => {
    expect(postingLink({ postingKey: 'key-1', applyContact: 'https://apply.example.test/x' })?.label).toBe('Apply page')
    expect(postingLink({ postingKey: 'key-1', applyContact: 'jobs@example.test' })).toEqual({ href: 'mailto:jobs@example.test', label: 'Apply by email' })
  })

  test('a plain key and no contact, or a script-shaped value, is no link', () => {
    expect(postingLink({ postingKey: 'key-1', applyContact: null })).toBeNull()
    expect(postingLink({ postingKey: 'javascript:alert(1)', applyContact: 'call the office' })).toBeNull()
  })
})

describe('score helpers', () => {
  test('gate state: rated 0 blocks, unrated is not measured, a soft requirement has none', () => {
    expect(gateState('gate', 0)).toBe('block')
    expect(gateState('gate', 0.4)).toBe('pass')
    expect(gateState('gate', null)).toBe('unrated')
    expect(gateState('soft', 0)).toBeNull()
    expect(gateState(undefined, 0)).toBeNull()
  })

  test('the breakdown follows the set order and joins kind and weight', () => {
    const score = detailFixture().scores[0]!
    const rows = breakdownRows(score, REQUIREMENTS)

    expect(rows.map((row) => row.key)).toEqual(['remote', 'domain'])
    expect(rows[0]).toMatchObject({ kind: 'gate', gate: 'pass', coverage: 1 })
    expect(rows[1]).toMatchObject({ kind: 'soft', gate: null, weight: 2, coverage: 0.5 })
  })

  test('without the requirements, a rating keeps its label and reads with no kind or weight', () => {
    const rows = breakdownRows(detailFixture().scores[0]!, [])
    expect(rows.map((row) => [row.label, row.kind, row.weight])).toEqual([
      ['Domain fit', null, null],
      ['Remote friendly', null, null],
    ])
  })

  test('the band follows leadBand: ask between floor and threshold, skip on a blocked gate, unscored with no score', () => {
    const open = detailFixture().scores[0]!
    expect(scoreBand(open, breakdownRows(open, REQUIREMENTS), 0.5)).toBe('ask')
    expect(scoreBand(open, breakdownRows(open, REQUIREMENTS), 0.7)).toBe('skip')

    const blocked = detailFixture({ remoteCoverage: 0 }).scores[0]!
    expect(scoreBand(blocked, breakdownRows(blocked, REQUIREMENTS), 0.5)).toBe('skip')

    expect(scoreBand(null, [], 0.5)).toBe('unscored')
  })

  test('the latest score is the newest by day, then by id', () => {
    const base = detailFixture().scores[0]!
    const older = { ...base, score: { ...base.score, id: 9, scoredAt: '2026-09-01' } }
    const sameDayHigherId = { ...base, score: { ...base.score, id: 8 } }
    expect(latestScore([older, base])?.score.id).toBe(7)
    expect(latestScore([base, sameDayHigherId])?.score.id).toBe(8)
    expect(latestScore([])).toBeNull()
  })
})
