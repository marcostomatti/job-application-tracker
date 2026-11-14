import { describe, expect, test } from 'bun:test'

import {
  BackupSettingsPatchSchema,
  BackupSettingsSchema,
  CriteriaModeSchema,
} from '../../src/schemas/config.ts'

describe('CriteriaModeSchema', () => {
  test('accepts the two modes and nothing else', () => {
    expect(CriteriaModeSchema.safeParse('versioned').success).toBe(true)
    expect(CriteriaModeSchema.safeParse('perspective').success).toBe(true)
    expect(CriteriaModeSchema.safeParse('sideways').success).toBe(false)
    expect(CriteriaModeSchema.safeParse(null).success).toBe(false)
  })
})

describe('the backup schemas', () => {
  test('keep must be a whole number of at least one, because zero would mean no backups at all', () => {
    expect(BackupSettingsSchema.shape.keep.safeParse(0).success).toBe(false)
    expect(BackupSettingsSchema.shape.keep.safeParse(1.5).success).toBe(false)
    expect(BackupSettingsSchema.shape.keep.safeParse(2).success).toBe(true)
  })

  test('the interval is a whole number of days, at least one', () => {
    expect(BackupSettingsSchema.shape.intervalDays.safeParse(0).success).toBe(false)
    expect(BackupSettingsSchema.shape.intervalDays.safeParse(0.5).success).toBe(false)
    expect(BackupSettingsSchema.shape.intervalDays.safeParse(Infinity).success).toBe(false)
    expect(BackupSettingsSchema.shape.intervalDays.safeParse(14).success).toBe(true)
  })

  test('a patch names at least one field, refuses a field it does not know, and takes numbers only as numbers', () => {
    expect(BackupSettingsPatchSchema.safeParse({}).success).toBe(false)
    expect(BackupSettingsPatchSchema.safeParse({ enabled: false }).success).toBe(true)
    expect(BackupSettingsPatchSchema.safeParse({ keep: 2, directory: '/tmp' }).success).toBe(false)
    expect(BackupSettingsPatchSchema.safeParse({ enabled: 'false' }).success).toBe(false)
    expect(BackupSettingsPatchSchema.safeParse({ keep: '2' }).success).toBe(false)
  })
})
