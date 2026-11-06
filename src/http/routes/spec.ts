import type { RequestHandler } from 'express'
import type { z, ZodType } from 'zod'

import type { Db } from '../../data/repositories/db.ts'
import { jsonHandler, type JsonHandlerOptions, type PathOnlySchemas, type PathOnlyValues } from '../handler.ts'

export type HttpMethod = 'get' | 'post' | 'patch' | 'put'

/**
 * One route, as data, so a test can read the table that is mounted and not a copy of it.
 *
 * `path` is relative to `/api`. Its parameters are named after the fields of the tool's schema
 * (`:postingId`, not `:id`), because the schema is strict and a parameter it does not name would
 * be refused. A client cannot see a parameter's name, only the URL, so `/postings/:postingId`
 * and `/postings/:id` are the same route to it.
 *
 * `tools` and `schemas` run in step: `schemas[i]` is the very input schema object of the MCP tool
 * named `tools[i]`. A route that serves more than one tool lists each.
 */
export interface RouteSpec {
  readonly method: HttpMethod
  readonly path: string
  readonly tools: readonly string[]
  readonly schemas: readonly ZodType[]
  readonly handler: (db: Db) => RequestHandler
}

/**
 * A route only the web app needs, which mirrors no MCP tool, so it lists none. It still parses
 * with a strict schema from `src/schemas`, exactly as `route()` does; the schema is not listed in
 * `schemas`, because that list names tool inputs and runs in step with `tools`.
 */
export function webRoute<S extends ZodType>(
  method: HttpMethod,
  path: string,
  schema: S,
  run: (args: z.infer<S>, db: Db) => Promise<unknown>,
): RouteSpec {
  return { method, path, tools: [], schemas: [], handler: (db) => jsonHandler(schema, run, db) }
}

/** A route that mirrors exactly one tool: the tool's schema, and the work its `run` does. */
export function route<S extends ZodType, P extends PathOnlySchemas = Record<never, ZodType>>(
  method: HttpMethod,
  path: string,
  tool: string,
  schema: S,
  run: (args: z.infer<S>, db: Db, pathOnly: PathOnlyValues<P>) => Promise<unknown>,
  options?: JsonHandlerOptions<P>,
): RouteSpec {
  return {
    method,
    path,
    tools: [tool],
    schemas: [schema],
    handler: (db) => jsonHandler(schema, run, db, options),
  }
}
