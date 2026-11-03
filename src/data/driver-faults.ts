/** Postgres' SQLSTATE for a unique-constraint violation. */
const UNIQUE_VIOLATION = '23505'

/** Postgres' SQLSTATE for a foreign-key violation. */
const FOREIGN_KEY_VIOLATION = '23503'

/** The fields of a driver fault this module reads; everything else about it is noise. */
type DriverFault = { code?: string; constraint_name?: string }

/**
 * Whether `error`, or the driver error Drizzle wraps as its `cause`, is a violation with this
 * SQLSTATE of the named constraint. The bare driver error counts as well as the wrapped one.
 */
function isViolation(error: unknown, sqlState: string, constraint: string): boolean {
  const candidates = [error, error instanceof Error ? error.cause : undefined]
  return candidates.some((candidate) => {
    const fault = candidate as DriverFault | null | undefined
    return fault?.code === sqlState && fault.constraint_name === constraint
  })
}

/**
 * Whether `error` is the unique violation of the named constraint.
 *
 * It lives here, in the data layer, because the SQLSTATE and the constraint name are
 * driver knowledge. A repository turns the fault into the error its callers understand,
 * so nothing above the data layer has to know what 23505 means — and the driver's own
 * message, which repeats the whole query, never becomes a caller's error.
 */
export function isUniqueViolation(error: unknown, constraint: string): boolean {
  return isViolation(error, UNIQUE_VIOLATION, constraint)
}

/**
 * Whether `error` is the foreign-key violation of the named constraint: a row names a row
 * the key does not allow. Used where the key, and not application code, is the guarantee, so
 * the repository only types the fault the database raised.
 */
export function isForeignKeyViolation(error: unknown, constraint: string): boolean {
  return isViolation(error, FOREIGN_KEY_VIOLATION, constraint)
}
