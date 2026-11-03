import type { RequestHandler } from 'express'

import type { Db } from '../../data/repositories/db.ts'
import { appendStageEvent, listSetAside, recordRejection, setAside } from '../../data/repositories/dispositions.ts'
import { EmptyInputSchema } from '../../schemas/common.ts'
import { RecordRejectionInputSchema, SetAsideInputSchema, StageEventInputSchema } from '../../schemas/dispositions.ts'
import { inputError, jsonHandler, sendInputError } from '../handler.ts'
import { route, type RouteSpec } from './spec.ts'

const SET_ASIDE_FIELD = 'setAsideReasonId'
const REJECTION_FIELD = 'rejectionReasonId'

/** Whether the JSON body names a field at all; a body that is not an object names none. */
function bodyNames(body: unknown, field: string): boolean {
  return typeof body === 'object' && body !== null && field in body
}

/**
 * One URL, two tools. `position_set_aside` and `position_reject` take different schemas on
 * purpose (their reasons come from different registries and are never interchangeable), so the
 * route does not merge them into a third schema. It sends the request to the handler of the one
 * whose reason field the body carries, and each handler parses with its own tool's schema, so a
 * rejection still refuses a set-aside field and the other way round.
 *
 * A body naming both reasons or neither says nothing about which tool is meant, and is a 400
 * that names the two fields. The choice reads the key's presence and never a registry row's
 * `key` or `label`.
 */
function dispositionHandler(db: Db): RequestHandler {
  const toSetAside = jsonHandler(SetAsideInputSchema, async (args, tx) => setAside(tx, args), db)
  const toRejection = jsonHandler(RecordRejectionInputSchema, async (args, tx) => recordRejection(tx, args), db)
  return (req, res, next) => {
    const aside = bodyNames(req.body, SET_ASIDE_FIELD)
    const rejection = bodyNames(req.body, REJECTION_FIELD)
    if (aside === rejection) {
      return sendInputError(
        res,
        inputError(`send exactly one of ${SET_ASIDE_FIELD} (to set the position aside) or ${REJECTION_FIELD} (to record a rejection)`),
      )
    }
    return (aside ? toSetAside : toRejection)(req, res, next)
  }
}

/** The routes for where a position stands: a stage event, a set-aside or a rejection, and what is set aside. */
export const dispositionRoutes: readonly RouteSpec[] = [
  route('post', '/positions/:positionId/stage', 'stage_append', StageEventInputSchema, async (args, db) =>
    appendStageEvent(db, args),
  ),
  {
    method: 'post',
    path: '/positions/:positionId/disposition',
    tools: ['position_set_aside', 'position_reject'],
    schemas: [SetAsideInputSchema, RecordRejectionInputSchema],
    handler: dispositionHandler,
  },
  route('get', '/set-aside', 'set_aside_list', EmptyInputSchema, async (_args, db) => listSetAside(db)),
]
