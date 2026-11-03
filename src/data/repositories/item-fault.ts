import { ArchivedError, ConflictError, NotFoundError } from '../../errors.ts'

/**
 * The failures that are about one item of a call, as against the database being unreachable:
 * a duplicate, an archived or unknown vocabulary row, a missing position. A bulk write wraps
 * these in a `BulkItemError` that names the item, and lets any other fault, such as a lost
 * connection, reach the caller as it is, because that is not a mistake in the input. This is
 * the one definition of that judgement; every bulk write, in a repository or a tool, uses it.
 */
export function isItemFault(error: unknown): boolean {
  return error instanceof ConflictError || error instanceof ArchivedError || error instanceof NotFoundError
}
