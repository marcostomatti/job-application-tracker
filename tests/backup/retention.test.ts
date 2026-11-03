import { describe, expect, test } from 'bun:test'

import {
  backupFileName,
  isBackupFileName,
  parseBackupTime,
  planRetention,
  type BackupFile,
} from '../../src/backup/retention.ts'

const named = (...names: string[]): BackupFile[] => names.map((name) => ({ name }))

const OLDEST = 'tracker-20261001T000000Z.dump'
const MIDDLE = 'tracker-20261015T120000Z.dump'
const NEWEST = 'tracker-20261029T235959Z.dump'

describe('planRetention', () => {
  test('keeps the newest and drops the rest for keep = 1', () => {
    // Arrange: given out of order, so the plan has to sort by name
    const files = named(MIDDLE, NEWEST, OLDEST)

    // Act
    const plan = planRetention(files, 1)

    // Assert
    expect(plan.keep.map((file) => file.name)).toEqual([NEWEST])
    expect(plan.drop.map((file) => file.name)).toEqual([MIDDLE, OLDEST])
  })

  test('keeps everything when keep exceeds the file count', () => {
    const files = named(OLDEST, NEWEST)

    const plan = planRetention(files, 5)

    expect(plan.keep.map((file) => file.name)).toEqual([NEWEST, OLDEST])
    expect(plan.drop).toEqual([])
  })

  test('with keep = 0 drops nothing, because 0 would mean no backups at all', () => {
    const files = named(OLDEST, MIDDLE, NEWEST)

    const plan = planRetention(files, 0)

    expect(plan.drop).toEqual([])
    expect(plan.keep).toHaveLength(3)
  })

  test.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('with keep = %p drops nothing', (keep) => {
    const plan = planRetention(named(OLDEST, NEWEST), keep)

    expect(plan.drop).toEqual([])
  })

  test('does not reorder or change the list it was given', () => {
    const files = Object.freeze(named(OLDEST, NEWEST))

    planRetention(files, 1)

    expect(files.map((file) => file.name)).toEqual([OLDEST, NEWEST])
  })

  test('returns empty plans for no files', () => {
    expect(planRetention([], 1)).toEqual({ keep: [], drop: [] })
  })
})

describe('backup file names', () => {
  test('are a sortable UTC timestamp, so name order is time order', () => {
    const earlier = backupFileName(new Date('2026-11-03T09:05:07Z'))
    const later = backupFileName(new Date('2026-11-03T10:00:00Z'))

    expect(earlier).toBe('tracker-20261103T090507Z.dump')
    expect(earlier < later).toBe(true)
  })

  test('are recognised, and nothing else in the directory is', () => {
    expect(isBackupFileName(NEWEST)).toBe(true)
    expect(isBackupFileName(`${NEWEST}.partial`)).toBe(false)
    expect(isBackupFileName('notes.txt')).toBe(false)
    expect(isBackupFileName('../tracker-20261029T235959Z.dump')).toBe(false)
  })

  test('give their time back', () => {
    expect(parseBackupTime(NEWEST)?.toISOString()).toBe('2026-10-29T23:59:59.000Z')
    expect(parseBackupTime('notes.txt')).toBeNull()
  })
})
