import type { Request, RequestHandler, Response } from 'express'
import { z, ZodError, type ZodType } from 'zod'

import type { Db } from '../data/repositories/db.ts'
import { statusFor } from '../errors.ts'
import { isRecord } from '../guards.ts'
import { lazyLogger } from '../logging.ts'
import { describeError } from '../mcp/result.ts'

const STATUS_BAD_REQUEST = 400
const STATUS_INTERNAL = 500

/** The name a caller sees on a refused request, which says the input was at fault. */
const VALIDATION_ERROR_NAME = 'ValidationError'

/** Schemas, by name, for path parameters that locate a resource but are not part of any tool's input. */
export type PathOnlySchemas = Readonly<Record<string, ZodType>>

/** What `run` receives for those parameters: each one parsed with its own schema. */
export type PathOnlyValues<P extends PathOnlySchemas> = { readonly [K in keyof P]: z.infer<P[K]> }

/** Options a route passes when its path carries more than its tool's schema names. */
export interface JsonHandlerOptions<P extends PathOnlySchemas> {
  readonly pathOnly: P
}

/** The module's own logger, made on first use so importing this file starts no logger. */
const logger = lazyLogger('http')

/** A refusal of the caller's input that names one field, or the whole request when `field` is absent. */
export function inputError(message: string, field?: string): ZodError {
  return new ZodError([{ code: 'custom', path: field === undefined ? [] : [field], message }])
}

/**
 * The text a caller reads for a refused request: every issue, led by the field it is about.
 * It is built from each issue's path and message only, never from the received value, so a
 * refusal cannot echo a secret back.
 */
function describeInput(error: ZodError): string {
  return error.issues
    .map((issue) => (issue.path.length === 0 ? issue.message : `${issue.path.map(String).join('.')}: ${issue.message}`))
    .join('; ')
}

/** Answers 400 for input the caller got wrong. `describeError` is not used: it flattens a `ZodError`. */
export function sendInputError(res: Response, error: ZodError): void {
  res.status(STATUS_BAD_REQUEST).json({
    success: false,
    error: { name: VALIDATION_ERROR_NAME, message: describeInput(error) },
  })
}

/**
 * Answers for an error thrown while doing the work, never while reading the request. The status
 * is `statusFor`'s and the text is `describeError`'s, which is also what the MCP surface sends, so
 * the two cannot word one failure differently.
 *
 * A `ZodError` is the exception to `statusFor`: out here it can only have come from inside the
 * server (a parse of stored data, say), because the request was already parsed, so it is a 500
 * with the flat text. `statusFor` maps it to 400 for the benefit of a caller's own bad input,
 * and answering 400 with "internal error" beside it would blame the caller for the server.
 */
export function sendFailure(res: Response, error: unknown): void {
  const status = error instanceof ZodError ? STATUS_INTERNAL : statusFor(error)
  if (status >= STATUS_INTERNAL) logger().error({ err: error }, 'request failed')
  res.status(status).json({ success: false, error: describeError(error) })
}

/**
 * The one object a schema parses: the path's parameters, the query and the body, in that order.
 *
 * The brief's order lets a body field overwrite a path parameter of the same name, which would
 * let `PATCH /positions/5` with a body naming position 9 change position 9 under a URL that says
 * 5. So a name claimed by the path may not also arrive in the query or the body; that is a 400
 * naming the field, and nothing is overwritten. Between the query and the body, which the path
 * does not name, the body wins, as the order says.
 */
function mergeInput(req: Request, withheld: ReadonlySet<string>): Record<string, unknown> {
  const body: unknown = req.body
  if (body !== undefined && !isRecord(body)) throw inputError('the request body must be a JSON object')
  const params = Object.fromEntries(Object.entries(req.params).filter(([name]) => !withheld.has(name)))
  const others = { ...req.query, ...body }
  for (const name of Object.keys(params)) {
    if (name in others) throw inputError('is named by the path and must not also be sent in the query or body', name)
  }
  return { ...params, ...others }
}

/** The path parameters the tool's schema does not name, parsed on schemas of their own. */
function parsePathOnly<P extends PathOnlySchemas>(req: Request, schemas: P | undefined): PathOnlyValues<P> {
  if (schemas === undefined) return {} as PathOnlyValues<P>
  const raw = Object.fromEntries(Object.keys(schemas).map((name) => [name, req.params[name]]))
  return z.strictObject(schemas).parse(raw) as PathOnlyValues<P>
}

/**
 * Adapts a tool's input schema and work to an Express handler. It parses
 * `{ ...req.params, ...req.query, ...req.body }` with the very schema object the MCP tool
 * registers, so a route and its tool cannot disagree about what a valid request is, then calls
 * `run` and answers `{ success: true, data }`.
 *
 * A request the schema refuses is a 400 naming the field, and `run` is never called, so the
 * data layer is not reached. This is the opposite of the MCP envelope, which treats a
 * `ZodError` as internal because the SDK has already validated: here this function is the
 * validator, so a `ZodError` from the parse is the caller's.
 *
 * `db` is a parameter because the brief's signature gave `run` a database and no way to obtain
 * one. `options.pathOnly` is for a path that names more than the tool's schema does (the set in
 * `/criteria-sets/:criteriaSetId/requirements/:requirementId`): those parameters are withheld
 * from the strict parse, parsed on their own schemas, and handed to `run` as a third argument.
 */
export function jsonHandler<S extends ZodType, P extends PathOnlySchemas = Record<never, ZodType>>(
  schema: S,
  run: (args: z.infer<S>, db: Db, pathOnly: PathOnlyValues<P>) => Promise<unknown>,
  db: Db,
  options?: JsonHandlerOptions<P>,
): RequestHandler {
  const withheld = new Set(Object.keys(options?.pathOnly ?? {}))
  return async (req, res): Promise<void> => {
    let args: z.infer<S>
    let pathOnly: PathOnlyValues<P>
    try {
      const parsed = schema.safeParse(mergeInput(req, withheld))
      if (!parsed.success) return sendInputError(res, parsed.error)
      args = parsed.data
      pathOnly = parsePathOnly(req, options?.pathOnly)
    } catch (error: unknown) {
      if (error instanceof ZodError) return sendInputError(res, error)
      return sendFailure(res, error)
    }
    try {
      const data = await run(args, db, pathOnly)
      res.json({ success: true, data: data === undefined ? null : data })
    } catch (error: unknown) {
      sendFailure(res, error)
    }
  }
}
