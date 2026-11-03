/** Postgres' SQLSTATE for a unique-constraint violation. */
const UNIQUE_VIOLATION = '23505'

/** The fields of a driver fault this module reads; everything else about it is noise. */
type DriverFault = { code?: string; constraint_name?: string }

/**
 * Whether `error` is the unique violation of the named constraint. Drizzle wraps the
 * driver error as `cause`, so the bare driver error counts as well as the wrapped one.
 *
 * It lives here, in the data layer, because the SQLSTATE and the constraint name are
 * driver knowledge. A repository turns the fault into the error its callers understand,
 * so nothing above the data layer has to know what 23505 means — and the driver's own
 * message, which repeats the whole query, never becomes a caller's error.
 */
export function isUniqueViolation(error: unknown, constraint: string): boolean {
  const candidates = [error, error instanceof Error ? error.cause : undefined]
  return candidates.some((candidate) => {
    const fault = candidate as DriverFault | null | undefined
    return fault?.code === UNIQUE_VIOLATION && fault.constraint_name === constraint
  })
}
