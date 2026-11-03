import { describe, expect, test } from 'bun:test'

import type { Origin } from '../../src/entities/provenance.ts'
import { firstTouch } from '../../src/provenance/first-touch.ts'

const TODAY = new Date('2026-11-20T00:00:00Z')

/** An origin on 2026-11-`day`, recorded at noon UTC on 2026-11-`recorded`, unless overridden. */
function touch(id: number, day: number, recorded: number, overrides: Partial<Origin> = {}): Origin {
  return {
    id,
    positionId: 1,
    routeId: id,
    touchedOn: `2026-11-${String(day).padStart(2, '0')}`,
    recordedAt: new Date(`2026-11-${String(recorded).padStart(2, '0')}T12:00:00Z`),
    note: null,
    searchRunId: null,
    ...overrides,
  }
}

describe('firstTouch', () => {
  test('picks the earliest touched_on', () => {
    // Arrange
    const origins = [touch(1, 12, 12), touch(2, 5, 12), touch(3, 9, 12)]

    // Act
    const result = firstTouch(origins, TODAY)

    // Assert
    expect(result?.id).toBe(2)
  })

  test('a backdated conversation entered later takes over first touch', () => {
    // Arrange: a query on the 10th, a recruiter message on the 12th, and a friend
    // conversation that happened on the 3rd but was only remembered and recorded on the 14th
    const query = touch(1, 10, 10)
    const recruiter = touch(2, 12, 12)
    const conversation = touch(3, 3, 14)

    // Act
    const beforeRemembering = firstTouch([query, recruiter], TODAY)
    const afterRemembering = firstTouch([query, recruiter, conversation], TODAY)

    // Assert
    expect(beforeRemembering?.id).toBe(1)
    expect(afterRemembering?.id).toBe(3)
  })

  test('falls back to the query once the backdated origin is removed', () => {
    // Arrange
    const query = touch(1, 10, 10)
    const recruiter = touch(2, 12, 12)
    const conversation = touch(3, 3, 14)
    const withConversation = [query, recruiter, conversation]

    // Act
    const withoutConversation = withConversation.filter((origin) => origin.id !== conversation.id)
    const result = firstTouch(withoutConversation, TODAY)

    // Assert
    expect(result?.id).toBe(1)
  })

  test('breaks a touched_on tie by recorded_at then id', () => {
    // Arrange: all three share a day; the second was recorded earliest; two share a recorded_at
    const laterRecorded = touch(1, 8, 15)
    const earliestRecorded = touch(2, 8, 9)
    const sameInstantLowerId = touch(3, 8, 9)
    const sameInstantHigherId = touch(7, 8, 9)

    // Act
    const byRecordedAt = firstTouch([laterRecorded, earliestRecorded], TODAY)
    const byId = firstTouch([sameInstantHigherId, laterRecorded, sameInstantLowerId], TODAY)

    // Assert
    expect(byRecordedAt?.id).toBe(2)
    expect(byId?.id).toBe(3)
  })

  test('ignores an origin dated after today', () => {
    // Arrange: a typo of next year, plus one dated today, which still counts
    const typo = touch(1, 2, 12, { touchedOn: '2027-11-02' })
    const real = touch(2, 15, 15)
    const dueToday = touch(3, 20, 20)
    const origins = Object.freeze([typo, real])

    // Act
    const result = firstTouch(origins, TODAY)
    const onlyTypo = firstTouch([typo], TODAY)
    const onlyToday = firstTouch([dueToday], TODAY)

    // Assert: the typo is skipped, the input still holds it, and a day equal to today counts
    expect(result?.id).toBe(2)
    expect(origins).toContain(typo)
    expect(onlyTypo).toBeNull()
    expect(onlyToday?.id).toBe(3)
  })

  test('returns null for a position with no origins', () => {
    // Arrange / Act / Assert
    expect(firstTouch([], TODAY)).toBeNull()
  })
})
