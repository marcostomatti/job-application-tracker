/** One backup on disk. Only the name matters to retention: it carries the time. */
export type BackupFile = { readonly name: string }

/** What a plan keeps, newest first, and what it drops, newest first among those. */
export type RetentionPlan = { readonly keep: BackupFile[]; readonly drop: BackupFile[] }

const PREFIX = 'tracker-'
const SUFFIX = '.dump'

/** `20261103T090507Z`: four-digit year to two-digit second, fixed width, so name order is time order. */
const STAMP_PATTERN = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/

/**
 * A backup's file name: the UTC time, fixed width and most significant digit first, so
 * sorting names as plain strings sorts them by time. The name holds nothing about the
 * database, the host or the person.
 */
export function backupFileName(now: Date): string {
  const stamp = now.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '')
  return `${PREFIX}${stamp}${SUFFIX}`
}

/**
 * The time a backup name carries, or `null` when the name is not one this module made.
 * The check is on the whole name, so a partial file or a stranger in the directory has none.
 */
export function parseBackupTime(name: string): Date | null {
  if (!name.startsWith(PREFIX) || !name.endsWith(SUFFIX)) return null
  const parts = STAMP_PATTERN.exec(name.slice(PREFIX.length, name.length - SUFFIX.length))
  if (!parts) return null
  const [, year, month, day, hour, minute, second] = parts
  const time = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`)
  return Number.isNaN(time.getTime()) ? null : time
}

/** Whether a directory entry is a backup, and so may be counted or removed by retention. */
export function isBackupFileName(name: string): boolean {
  return parseBackupTime(name) !== null
}

/**
 * Which backups stay and which go: the `keep` newest stay, found by name, and the rest go.
 *
 * A `keep` that is not a positive whole number drops nothing. Zero would mean no backups at
 * all, which a retention setting must not be able to say by accident (`enabled: false` is the
 * way to turn backups off), and a fraction or a negative number has no meaning to fall back
 * on but the safe one. The list passed in is not changed.
 */
export function planRetention(files: readonly BackupFile[], keep: number): RetentionPlan {
  const newestFirst = [...files].sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0))
  if (!Number.isInteger(keep) || keep < 1) return { keep: newestFirst, drop: [] }
  return { keep: newestFirst.slice(0, keep), drop: newestFirst.slice(keep) }
}
