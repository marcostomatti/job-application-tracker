import { describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'

import type { DrizzleClient } from '../../src/data/client.ts'
import {
  BACKUP_DEFAULTS,
  readBackupSettings,
  readMode,
  setBackupSettings,
  setMode,
} from '../../src/data/repositories/config.ts'
import {
  BackupSettingsPatchSchema,
  BackupSettingsSchema,
  CriteriaModeSchema,
} from '../../src/schemas/config.ts'
import { withMigratedScratchDatabase } from '../data/scratch-database.ts'

type Logged = { readonly context: object; readonly message: string }

/** A logger that records what it is told, so a fallback can be seen rather than assumed. */
function spyLogger(): { readonly logger: { warn(context: object, message: string): void }; readonly logged: Logged[] } {
  const logged: Logged[] = []
  return { logger: { warn: (context, message) => void logged.push({ context, message }) }, logged }
}

/** Writes a raw jsonb literal, the way a person editing the table by hand would. */
async function handEdit(db: DrizzleClient, key: string, jsonLiteral: string): Promise<void> {
  await db.execute(
    sql`insert into app_config (key, value) values (${key}, ${jsonLiteral}::jsonb)
        on conflict (key) do update set value = excluded.value`,
  )
}

describe('readMode', () => {
  test('returns versioned when the key is absent, without logging, because absence is normal', async () => {
    // Arrange
    const { logger, logged } = spyLogger()

    // Act
    const mode = await withMigratedScratchDatabase((db) => readMode(db, logger))

    // Assert
    expect(mode).toBe('versioned')
    expect(logged).toEqual([])
  })

  test('returns perspective once it is set, and versioned once it is set back', async () => {
    // Arrange
    const { logger, logged } = spyLogger()

    // Act
    const { first, second } = await withMigratedScratchDatabase(async (db) => {
      await setMode(db, 'perspective')
      const first = await readMode(db, logger)
      await setMode(db, 'versioned')
      return { first, second: await readMode(db, logger) }
    })

    // Assert
    expect(first).toBe('perspective')
    expect(second).toBe('versioned')
    expect(logged).toEqual([])
  })

  test('stores the mode as a jsonb string, not as a string of encoded JSON', async () => {
    // Arrange / Act
    const rows = await withMigratedScratchDatabase(async (db) => {
      await setMode(db, 'perspective')
      return db.execute(sql`select jsonb_typeof(value) as kind, value #>> '{}' as text from app_config where key = 'criteria_mode'`)
    })

    // Assert
    expect([...rows]).toEqual([{ kind: 'string', text: 'perspective' }])
  })

  test('returns versioned for an unrecognised stored value, and logs it', async () => {
    // Arrange
    const { logger, logged } = spyLogger()

    // Act
    const mode = await withMigratedScratchDatabase(async (db) => {
      await handEdit(db, 'criteria_mode', '"sideways"')
      return readMode(db, logger)
    })

    // Assert
    expect(mode).toBe('versioned')
    expect(logged).toHaveLength(1)
    expect(logged[0]?.context).toMatchObject({ key: 'criteria_mode', stored: 'sideways' })
    expect(logged[0]?.message).toContain('criteria mode')
  })

  test.each([
    ['a number', '3', 'number'],
    ['an object', '{"mode":"perspective"}', 'object'],
    ['an array', '["perspective"]', 'array'],
    ['a boolean', 'true', 'boolean'],
    ['a JSON null', 'null', 'null'],
    ['an empty string', '""', ''],
    ['a recognised word in the wrong case', '"Perspective"', 'Perspective'],
  ])('falls back to versioned and logs when the stored value is %s', async (_label, literal, shown) => {
    // Arrange
    const { logger, logged } = spyLogger()

    // Act
    const mode = await withMigratedScratchDatabase(async (db) => {
      await handEdit(db, 'criteria_mode', literal)
      return readMode(db, logger)
    })

    // Assert
    expect(mode).toBe('versioned')
    expect(logged).toHaveLength(1)
    expect(logged[0]?.context).toMatchObject({ key: 'criteria_mode', stored: shown })
  })

  test('does not echo a long hand-edited string whole into the log', async () => {
    // Arrange
    const { logger, logged } = spyLogger()
    const long = 'x'.repeat(5000)

    // Act
    await withMigratedScratchDatabase(async (db) => {
      await handEdit(db, 'criteria_mode', JSON.stringify(long))
      return readMode(db, logger)
    })

    // Assert
    const stored = (logged[0]?.context as { stored: string }).stored
    expect(stored.length).toBeLessThan(200)
  })

  test('is repaired by the next setMode, which replaces the odd value', async () => {
    // Arrange
    const { logger, logged } = spyLogger()

    // Act
    const mode = await withMigratedScratchDatabase(async (db) => {
      await handEdit(db, 'criteria_mode', '"sideways"')
      await setMode(db, 'perspective')
      return readMode(db, logger)
    })

    // Assert
    expect(mode).toBe('perspective')
    expect(logged).toEqual([])
  })
})

describe('CriteriaModeSchema', () => {
  test('accepts the two modes and nothing else', () => {
    expect(CriteriaModeSchema.safeParse('versioned').success).toBe(true)
    expect(CriteriaModeSchema.safeParse('perspective').success).toBe(true)
    expect(CriteriaModeSchema.safeParse('sideways').success).toBe(false)
    expect(CriteriaModeSchema.safeParse(null).success).toBe(false)
  })
})

describe('readBackupSettings and setBackupSettings', () => {
  test('returns the defaults when nothing is stored, without logging', async () => {
    // Arrange
    const { logger, logged } = spyLogger()

    // Act
    const settings = await withMigratedScratchDatabase((db) => readBackupSettings(db, logger))

    // Assert
    expect(settings).toEqual(BACKUP_DEFAULTS)
    expect(BACKUP_DEFAULTS).toEqual({ enabled: true, keep: 1, intervalDays: 14 })
    expect(logged).toEqual([])
  })

  test('turns backups off with one setting and keeps the rest at their defaults', async () => {
    // Arrange / Act
    const { written, read } = await withMigratedScratchDatabase(async (db) => {
      const written = await setBackupSettings(db, { enabled: false })
      return { written, read: await readBackupSettings(db) }
    })

    // Assert
    expect(written).toEqual({ ...BACKUP_DEFAULTS, enabled: false })
    expect(read).toEqual(written)
  })

  test('merges a patch over what is stored, so a second patch does not undo the first', async () => {
    // Arrange / Act
    const read = await withMigratedScratchDatabase(async (db) => {
      await setBackupSettings(db, { keep: 3 })
      await setBackupSettings(db, { intervalDays: 7 })
      return readBackupSettings(db)
    })

    // Assert
    expect(read).toEqual({ enabled: true, keep: 3, intervalDays: 7 })
  })

  test('reads a hand-written partial object field by field, filling the gaps silently', async () => {
    // Arrange
    const { logger, logged } = spyLogger()

    // Act
    const read = await withMigratedScratchDatabase(async (db) => {
      await handEdit(db, 'backup', '{"keep": 4}')
      return readBackupSettings(db, logger)
    })

    // Assert
    expect(read).toEqual({ enabled: true, keep: 4, intervalDays: 14 })
    expect(logged).toEqual([])
  })

  test('keeps enabled: false when another field is invalid, so a typo cannot switch backups back on', async () => {
    // Arrange
    const { logger, logged } = spyLogger()

    // Act
    const read = await withMigratedScratchDatabase(async (db) => {
      await handEdit(db, 'backup', '{"enabled": false, "keep": 0, "intervalDays": "weekly"}')
      return readBackupSettings(db, logger)
    })

    // Assert
    expect(read).toEqual({ enabled: false, keep: 1, intervalDays: 14 })
    expect(logged).toHaveLength(1)
    expect(logged[0]?.context).toMatchObject({ key: 'backup', fields: ['keep', 'intervalDays'] })
  })

  test.each([
    ['a number', '5'],
    ['a string', '"daily"'],
    ['an array', '[1]'],
    ['a JSON null', 'null'],
  ])('falls back to the defaults and logs when the stored value is %s', async (_label, literal) => {
    // Arrange
    const { logger, logged } = spyLogger()

    // Act
    const read = await withMigratedScratchDatabase(async (db) => {
      await handEdit(db, 'backup', literal)
      return readBackupSettings(db, logger)
    })

    // Assert
    expect(read).toEqual(BACKUP_DEFAULTS)
    expect(logged).toHaveLength(1)
    expect(logged[0]?.context).toMatchObject({ key: 'backup' })
  })

  test('repairs an odd stored value when a patch is written over it', async () => {
    // Arrange
    const { logger, logged } = spyLogger()

    // Act
    const read = await withMigratedScratchDatabase(async (db) => {
      await handEdit(db, 'backup', '"daily"')
      await setBackupSettings(db, { keep: 2 }, logger)
      return readBackupSettings(db, logger)
    })

    // Assert
    expect(read).toEqual({ enabled: true, keep: 2, intervalDays: 14 })
    expect(logged).toHaveLength(1)
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
