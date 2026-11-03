import { Router, type Application } from 'express'

import type { Db } from '../../data/repositories/db.ts'
import { criteriaRoutes } from './criteria.ts'
import { dispositionRoutes } from './dispositions.ts'
import { positionRoutes } from './positions.ts'
import { registryRoutes } from './registries.ts'
import { scoreRoutes } from './scores.ts'
import type { RouteSpec } from './spec.ts'
import { textRoutes } from './texts.ts'

/** Every internal HTTP route, in the order of the brief's table (§11.2). */
export const ROUTES: readonly RouteSpec[] = [
  ...positionRoutes,
  ...scoreRoutes,
  ...dispositionRoutes,
  ...criteriaRoutes,
  ...registryRoutes,
  ...textRoutes,
]

/**
 * Mounts every route under `/api`.
 *
 * No API-key check is mounted here. The server entry mounts `requireApiKey` on `/api` before
 * calling this, and only when a key is configured; a second check in this function would test
 * the key twice and could not be switched off with the first.
 */
export function mountRoutes(app: Application, db: Db): void {
  const api = Router()
  for (const spec of ROUTES) api[spec.method](spec.path, spec.handler(db))
  app.use('/api', api)
}
