import type { RequestHandler } from 'express'
import type { z, ZodType } from 'zod'

import type { Db } from '../../data/repositories/db.ts'
import { appendStageEvent, listSetAside, recordRejection, setAside, stageHistory } from '../../data/repositories/dispositions.ts'
import { EmptyInputSchema } from '../../schemas/common.ts'
import { RecordRejectionInputSchema, SetAsideInputSchema, StageEventInputSchema } from '../../schemas/dispositions.ts'
import { PostingRefSchema } from '../../schemas/postings.ts'
import { inputError, jsonHandler, sendInputError } from '../handler.ts'
import { route, webRoute, type RouteSpec } from './spec.ts'

/** Whether the JSON body names a field at all; a body that is not an object names none. */
function bodyNames(body: unknown, field: string): boolean {
  return typeof body === 'object' && body !== null && field in body
}

/**
 * One tool the disposition route can serve. The tool name, its schema and the handler that parses
 * with that schema are all made here from the same arguments, so what the route declares and what
 * it parses with cannot differ, which is what `route()` does for a route with one tool.
 */
interface DispositionBranch {
  readonly tool: string
  readonly field: string
  readonly purpose: string
  readonly schema: ZodType
  readonly handler: (db: Db) => RequestHandler
}

function branch<S extends ZodType>(
  tool: string,
  field: string,
  purpose: string,
  schema: S,
  run: (args: z.infer<S>, db: Db) => Promise<unknown>,
): DispositionBranch {
  return { tool, field, purpose, schema, handler: (db) => jsonHandler(schema, run, db) }
}

/**
 * The two tools behind `/postings/:postingId/disposition`. They take different schemas on
 * purpose (their reasons come from different registries and are never interchangeable), so the
 * route does not merge them into a third schema. The choice reads which reason field the body
 * carries, never a registry row's `key` or `label`.
 */
const BRANCHES: readonly DispositionBranch[] = [
  branch('posting_set_aside', 'setAsideReasonId', 'to set the posting aside', SetAsideInputSchema, async (args, db) =>
    setAside(db, args),
  ),
  branch('posting_reject', 'rejectionReasonId', 'to record a rejection', RecordRejectionInputSchema, async (args, db) =>
    recordRejection(db, args),
  ),
]

/**
 * Sends the request to the branch whose reason field the body carries; each branch parses with
 * its own tool's schema, so a rejection still refuses a set-aside field and the other way round.
 * A body naming both reasons or neither says nothing about which tool is meant, and is a 400 that
 * names the fields.
 */
function dispositionHandler(db: Db): RequestHandler {
  const handlers = BRANCHES.map((candidate) => ({ field: candidate.field, handle: candidate.handler(db) }))
  const choices = BRANCHES.map((candidate) => `${candidate.field} (${candidate.purpose})`).join(' or ')
  return (req, res, next) => {
    const chosen = handlers.filter((candidate) => bodyNames(req.body, candidate.field))
    const [only] = chosen
    if (only === undefined || chosen.length > 1) return sendInputError(res, inputError(`send exactly one of ${choices}`))
    return only.handle(req, res, next)
  }
}

/** The routes for where a posting stands: a stage event, a set-aside or a rejection, and what is set aside. */
export const dispositionRoutes: readonly RouteSpec[] = [
  route('post', '/postings/:postingId/stage', 'stage_append', StageEventInputSchema, async (args, db) =>
    appendStageEvent(db, args),
  ),
  {
    method: 'post',
    path: '/postings/:postingId/disposition',
    tools: BRANCHES.map((candidate) => candidate.tool),
    schemas: BRANCHES.map((candidate) => candidate.schema),
    handler: dispositionHandler,
  },
  route('get', '/set-aside', 'set_aside_list', EmptyInputSchema, async (_args, db) => listSetAside(db)),
  // The posting page's timeline. No MCP tool reads the whole history (stage_current reads the latest event), so it mirrors none.
  webRoute('get', '/postings/:postingId/stages', PostingRefSchema, async (args, db) => stageHistory(db, args.postingId)),
]
