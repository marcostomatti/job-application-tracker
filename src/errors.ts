import { ZodError } from 'zod'

const HTTP_STATUS = {
  badRequest: 400,
  notFound: 404,
  conflict: 409,
  internal: 500,
  badGateway: 502,
  unavailable: 503,
} as const

/**
 * A thing the caller named does not exist. `cause` carries the driver fault when the database's
 * own foreign key is what found it out, and is never part of the message.
 */
export class NotFoundError extends Error {
  readonly entity: string
  readonly id: string | number

  constructor(
    entity: string,
    id: string | number,
    options?: ErrorOptions,
  ) {
    super(`${entity} ${id} does not exist`, options)
    this.entity = entity
    this.id = id
    this.name = 'NotFoundError'
  }
}

/**
 * The caller's request conflicts with what is stored: most often a thing it tried to create
 * already exists under this key, which is what the default message says. A conflict of another
 * kind, such as a rating that names something outside the set it was made under, passes its own
 * `message`, because "already exists" would be false for it. `field` and `key` still say what
 * collided. `cause` keeps the driver fault and is never part of the message.
 *
 * A custom `message` is shown to callers verbatim: the MCP and HTTP surfaces send a conflict's
 * message as it is, and a bulk failure repeats it. It must therefore be a literal built from
 * what the caller supplied, and never derived from a driver fault, whose message is the failed
 * SQL statement. The fault belongs on `cause`.
 */
export class ConflictError extends Error {
  readonly field: string
  readonly key: string

  constructor(
    field: string,
    key: string,
    options?: ErrorOptions & { message?: string },
  ) {
    super(options?.message ?? `${field} ${key} already exists`, options)
    this.field = field
    this.key = key
    this.name = 'ConflictError'
  }
}

/** A vocabulary row exists but may no longer be used. */
export class ArchivedError extends Error {
  readonly entity: string
  readonly id: string | number

  constructor(
    entity: string,
    id: string | number,
  ) {
    super(`${entity} ${id} is archived`)
    this.entity = entity
    this.id = id
    this.name = 'ArchivedError'
  }
}

/** One item in a bulk write failed; `index` says which one. The cause is kept off the message. */
export class BulkItemError extends Error {
  readonly index: number

  constructor(
    index: number,
    cause: unknown,
  ) {
    super(`bulk item ${index} failed`, { cause })
    this.index = index
    this.name = 'BulkItemError'
  }
}

/**
 * The Open Notebook companion could not be used: it did not answer, the connection failed, or
 * it answered in a shape this tracker does not know. `reason` is one of a few fixed phrases
 * written here, never the notebook's URL or a driver message, so it is safe to show a caller.
 */
export class NotebookUnavailableError extends Error {
  readonly reason: string

  constructor(
    reason: string,
    options?: ErrorOptions,
  ) {
    super(`the notebook is unavailable: ${reason}`, options)
    this.reason = reason
    this.name = 'NotebookUnavailableError'
  }
}

/**
 * The Open Notebook companion answered and refused the request. `status` is its HTTP status.
 * The message is a fixed phrase per kind of status and never carries the notebook's own
 * `detail`, because Open Notebook often builds that text from an internal exception.
 */
export class NotebookRequestError extends Error {
  readonly status: number

  constructor(
    status: number,
    message: string,
  ) {
    super(message)
    this.status = status
    this.name = 'NotebookRequestError'
  }
}

/** Maps an error to the HTTP status both surfaces send. Anything unrecognised is a 500. */
export function statusFor(error: unknown): number {
  if (error instanceof NotFoundError) return HTTP_STATUS.notFound
  if (error instanceof ConflictError || error instanceof ArchivedError) return HTTP_STATUS.conflict
  if (error instanceof BulkItemError || error instanceof ZodError) return HTTP_STATUS.badRequest
  if (error instanceof NotebookUnavailableError) return HTTP_STATUS.unavailable
  if (error instanceof NotebookRequestError) return HTTP_STATUS.badGateway
  return HTTP_STATUS.internal
}
