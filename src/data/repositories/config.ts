import { eq, sql } from 'drizzle-orm'
import { createLogger } from '@open-tomato/service-logger'

import {
  BackupSettingsSchema,
  CriteriaModeSchema,
  DEFAULT_CRITERIA_MODE,
  type BackupSettings,
  type BackupSettingsPatch,
  type CriteriaMode,
} from '../../schemas/config.ts'
import { appConfig } from '../schema/config.ts'
import type { Db } from './db.ts'

/** The `app_config` keys this module owns. */
const MODE_KEY = 'criteria_mode'
const BACKUP_KEY = 'backup'

/**
 * What a read does when a stored value cannot be used. A repository holds no request
 * context, so the logger is a parameter: a test passes a spy and sees the fallback, and a
 * production caller passes its own or takes the module's. The `service-logger` `Logger`
 * satisfies this.
 */
export type FallbackLog = { warn(context: object, message: string): void }

const defaultLogger: FallbackLog = createLogger('app-config')

/**
 * Backups on, one dump kept (each replaces the last rather than accumulating) and a
 * fortnight apart. Backups are the one place this layer carries a default, because `backup`
 * settings are the app's own behaviour and not the user's judgement.
 */
export const BACKUP_DEFAULTS: BackupSettings = { enabled: true, keep: 1, intervalDays: 14 }

/** The longest stored string a log line repeats; a hand-edited value can be any length. */
const LOGGED_VALUE_MAX = 80

/** What a stored value looks like, without repeating all of it: a short string whole, anything else by type. */
function describeStored(value: unknown): string {
  if (typeof value === 'string') return value.slice(0, LOGGED_VALUE_MAX)
  if (value === null) return 'null'
  return Array.isArray(value) ? 'array' : typeof value
}

async function readStored(db: Db, key: string): Promise<{ readonly value: unknown } | null> {
  const [row] = await db.select({ value: appConfig.value }).from(appConfig).where(eq(appConfig.key, key))
  return row ?? null
}

async function writeStored(db: Db, key: string, value: unknown): Promise<void> {
  await db
    .insert(appConfig)
    .values({ key, value })
    .onConflictDoUpdate({ target: appConfig.key, set: { value, updatedAt: sql`now()` } })
}

/**
 * The criteria mode. `app_config.criteria_mode` is jsonb with no CHECK and a person may edit
 * it by hand, so the stored value is untrusted: absent, a recognised mode, a string that is
 * not a mode, or something that is not a string at all (a number, an object, a JSON null) are
 * all possible. Only a recognised mode is used. Everything else falls back to `versioned` and
 * is logged, because a board that will not render is worse than a board in the default mode.
 * An absent key is the normal state of a fresh install and is not logged.
 */
export async function readMode(db: Db, logger: FallbackLog = defaultLogger): Promise<CriteriaMode> {
  const stored = await readStored(db, MODE_KEY)
  if (!stored) return DEFAULT_CRITERIA_MODE
  const parsed = CriteriaModeSchema.safeParse(stored.value)
  if (parsed.success) return parsed.data
  logger.warn({ key: MODE_KEY, stored: describeStored(stored.value) }, 'unrecognised criteria mode in app_config; using the default')
  return DEFAULT_CRITERIA_MODE
}

export async function setMode(db: Db, mode: CriteriaMode): Promise<void> {
  await writeStored(db, MODE_KEY, mode)
}

type FieldReading<K extends keyof BackupSettings> = { readonly value: BackupSettings[K]; readonly valid: boolean }

/**
 * One backup field from a stored object: the stored value when it fits, the default when it
 * is absent (`valid`) or does not fit (not `valid`). Reading field by field means one bad
 * field cannot cost the others, and above all cannot turn a stored `enabled: false` back on.
 */
function readField<K extends keyof BackupSettings>(stored: Readonly<Record<string, unknown>>, key: K): FieldReading<K> {
  if (!(key in stored)) return { value: BACKUP_DEFAULTS[key], valid: true }
  const parsed = BackupSettingsSchema.shape[key].safeParse(stored[key])
  return parsed.success
    ? { value: parsed.data as BackupSettings[K], valid: true }
    : { value: BACKUP_DEFAULTS[key], valid: false }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The backup settings, with a default for anything absent. Like the mode this is untrusted
 * jsonb: a stored value that is not an object yields the defaults, a field that does not fit
 * yields that field's default, and both are logged. A fresh install, with nothing stored,
 * yields the defaults silently.
 */
export async function readBackupSettings(db: Db, logger: FallbackLog = defaultLogger): Promise<BackupSettings> {
  const stored = await readStored(db, BACKUP_KEY)
  if (!stored) return BACKUP_DEFAULTS
  if (!isRecord(stored.value)) {
    logger.warn({ key: BACKUP_KEY, stored: describeStored(stored.value) }, 'unusable backup settings in app_config; using the defaults')
    return BACKUP_DEFAULTS
  }
  const readings = {
    enabled: readField(stored.value, 'enabled'),
    keep: readField(stored.value, 'keep'),
    intervalDays: readField(stored.value, 'intervalDays'),
  }
  const invalid = Object.entries(readings).flatMap(([field, reading]) => (reading.valid ? [] : [field]))
  if (invalid.length > 0) {
    logger.warn({ key: BACKUP_KEY, fields: invalid }, 'unusable backup settings in app_config; those fields use their defaults')
  }
  return { enabled: readings.enabled.value, keep: readings.keep.value, intervalDays: readings.intervalDays.value }
}

/**
 * Changes the named backup settings and keeps the rest as they read now, then stores and
 * returns the whole. `{ enabled: false }` is therefore the one setting that turns backups
 * off. Stored whole, so a later reader never meets a half-written object.
 */
export async function setBackupSettings(
  db: Db,
  patch: BackupSettingsPatch,
  logger: FallbackLog = defaultLogger,
): Promise<BackupSettings> {
  const merged: BackupSettings = { ...(await readBackupSettings(db, logger)), ...definedOnly(patch) }
  await writeStored(db, BACKUP_KEY, merged)
  return merged
}

/** A patch without its `undefined` fields, so spreading it cannot overwrite a stored value with nothing. */
function definedOnly(patch: BackupSettingsPatch): Partial<BackupSettings> {
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined))
}
