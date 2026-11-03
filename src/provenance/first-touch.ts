import type { Origin } from '../entities/provenance.ts'

/** The calendar day of `today` in UTC, as `YYYY-MM-DD`. Such strings order the way days do. */
function calendarDay(today: Date): string {
  return today.toISOString().slice(0, 10)
}

/** Negative when `a` is the earlier touch: by `touchedOn`, then `recordedAt`, then `id`. */
function byTouchOrder(a: Origin, b: Origin): number {
  if (a.touchedOn !== b.touchedOn) return a.touchedOn < b.touchedOn ? -1 : 1
  const recordedGap = a.recordedAt.getTime() - b.recordedAt.getTime()
  return recordedGap !== 0 ? recordedGap : a.id - b.id
}

/**
 * The origin that first reached a position, or null when none has. It is derived on every
 * call and never stored, so a conversation remembered later and entered with an earlier
 * `touchedOn` takes over without any row being edited. The SQL view `position_first_touch`
 * applies the same rule; a test compares the two.
 *
 * An origin dated after `today` is skipped, because `touchedOn` is typed by hand and a
 * mistyped year would otherwise become the lead's origin. The caller's array is not changed,
 * so the skipped row stays readable. A day equal to `today` counts.
 *
 * `today` is read as its UTC calendar day, to match a database running in UTC.
 */
export function firstTouch(origins: readonly Origin[], today: Date): Origin | null {
  const cutoff = calendarDay(today)
  const [earliest] = origins.filter((origin) => origin.touchedOn <= cutoff).sort(byTouchOrder)
  return earliest ?? null
}
