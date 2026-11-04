import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import {
  ArchivedError,
  BulkItemError,
  ConflictError,
  NotebookRequestError,
  NotebookUnavailableError,
  NotFoundError,
} from '../errors.ts'

/** What a caller is told about any error that is not one of the known classes: nothing. */
const INTERNAL_ERROR = { name: 'InternalError', message: 'internal error' } as const

/**
 * Wraps a value as the successful result of a tool call: one text block of JSON.
 *
 * `JSON.stringify(undefined)` returns `undefined` rather than a string, and a text block needs a
 * string, so a tool that returns nothing sends `null`. A value JSON cannot hold, such as a
 * `BigInt` or a cycle, makes `JSON.stringify` throw; that throw is left to the caller, because
 * `registerTools` runs this inside the same `try` as the tool and turns it into an
 * `errorResult`. Swallowing it here would send a caller a success that is not one.
 */
export function okResult(value: unknown): CallToolResult {
  const text = JSON.stringify(value) ?? 'null'
  return { content: [{ type: 'text', text }] }
}

/**
 * The classes whose name and message are safe to show a caller. `CriteriaSetConflictError`
 * extends `ConflictError`, so it is caught by that entry. The two notebook errors are here because
 * their messages are built from fixed phrases and a status, never from a URL, a key or the
 * notebook's own error text. `ZodError` is not here: the SDK
 * parses a tool's input before `run` is reached, so a `ZodError` that arrives here came from
 * inside the server, and its issues could carry stored data.
 */
function isKnownError(error: unknown): error is Error {
  return (
    error instanceof NotFoundError ||
    error instanceof ConflictError ||
    error instanceof ArchivedError ||
    error instanceof BulkItemError ||
    error instanceof NotebookUnavailableError ||
    error instanceof NotebookRequestError
  )
}

/** The two fields a caller is shown for an error, and nothing else. */
export interface ErrorDescription {
  readonly name: string
  readonly message: string
}

/**
 * What a caller is told about an error, built field by field from `name` and `message` and
 * nothing else. This is the one place the wording is decided, so a surface that wraps it in its
 * own envelope (the MCP content block here, `{ success: false, error }` over HTTP) shows the
 * same text for the same failure. It never serialises the error and never reads `cause` except
 * as described next, because `cause` holds the driver fault, and a driver fault's message is the
 * failed SQL statement.
 *
 * A `BulkItemError` says which item failed, and adds why when its cause is itself a known class,
 * because those messages are built from fields the caller supplied. An unknown cause adds
 * nothing, so the leak property holds.
 *
 * A known class's message is emitted verbatim, so it must never be derived from a driver fault,
 * and that includes the free-text `message` option of `ConflictError`: pass a literal built from
 * what the caller supplied, never `error.message` of a caught driver error.
 *
 * An error outside the known classes could be anything, a connection string included, so it
 * becomes the same flat constant, `InternalError` with `internal error`, which carries nothing
 * of the thrown value: no name, no message, no cause. A `ZodError`
 * is flat here only because this is called from the MCP handler, where the SDK has already
 * parsed the input. A surface that parses with the schema itself must treat a `ZodError` as
 * caller input before it reaches this function.
 */
export function describeError(error: unknown): ErrorDescription {
  if (!isKnownError(error)) return INTERNAL_ERROR
  const { name, message } = error
  if (error instanceof BulkItemError && isKnownError(error.cause)) {
    return { name, message: `${message}: ${error.cause.message}` }
  }
  return { name, message }
}

/** Turns anything a tool threw into an error result carrying `describeError`'s text. */
export function errorResult(error: unknown): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error: describeError(error) }) }],
  }
}

/**
 * A single-item tool is built on the bulk repository function with a one-element array, so its
 * failure arrives as a `BulkItemError` at index 0 wrapping the real cause. This returns that
 * cause, and returns any other error, including a `BulkItemError` at another index, unchanged.
 */
export function unwrapSingleItem(error: unknown): unknown {
  return error instanceof BulkItemError && error.index === 0 ? error.cause : error
}
