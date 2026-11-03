import { ZodError } from 'zod'

const HTTP_STATUS = {
  badRequest: 400,
  notFound: 404,
  conflict: 409,
  internal: 500,
} as const

/** A thing the caller named does not exist. */
export class NotFoundError extends Error {
  constructor(
    readonly entity: string,
    readonly id: string | number,
  ) {
    super(`${entity} ${id} does not exist`)
    this.name = 'NotFoundError'
  }
}

/**
 * The caller's request conflicts with what is stored: most often a thing it tried to create
 * already exists under this key, which is what the default message says. A conflict of another
 * kind, such as a rating that names something outside the set it was made under, passes its own
 * `message`, because "already exists" would be false for it. `field` and `key` still say what
 * collided. `cause` keeps the driver fault and is never part of the message.
 */
export class ConflictError extends Error {
  constructor(
    readonly field: string,
    readonly key: string,
    options?: ErrorOptions & { message?: string },
  ) {
    super(options?.message ?? `${field} ${key} already exists`, options)
    this.name = 'ConflictError'
  }
}

/** A vocabulary row exists but may no longer be used. */
export class ArchivedError extends Error {
  constructor(
    readonly entity: string,
    readonly id: string | number,
  ) {
    super(`${entity} ${id} is archived`)
    this.name = 'ArchivedError'
  }
}

/** One item in a bulk write failed; `index` says which one. The cause is kept off the message. */
export class BulkItemError extends Error {
  constructor(
    readonly index: number,
    cause: unknown,
  ) {
    super(`bulk item ${index} failed`, { cause })
    this.name = 'BulkItemError'
  }
}

/** Maps an error to the HTTP status both surfaces send. Anything unrecognised is a 500. */
export function statusFor(error: unknown): number {
  if (error instanceof NotFoundError) return HTTP_STATUS.notFound
  if (error instanceof ConflictError || error instanceof ArchivedError) return HTTP_STATUS.conflict
  if (error instanceof BulkItemError || error instanceof ZodError) return HTTP_STATUS.badRequest
  return HTTP_STATUS.internal
}
