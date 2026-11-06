import { Router, type Application } from 'express'

import type { Db } from '../../data/repositories/db.ts'
import { criteriaRoutes } from './criteria.ts'
import { dispositionRoutes } from './dispositions.ts'
import { postingRoutes } from './postings.ts'
import { questionRoutes } from './questions.ts'
import { registryRoutes } from './registries.ts'
import { scoreRoutes } from './scores.ts'
import { settingsRoutes } from './settings.ts'
import type { RouteSpec } from './spec.ts'
import { statsRoutes } from './stats.ts'
import { textRoutes } from './texts.ts'

/** Every internal HTTP route, in the order of the brief's table (§11.2), then the question writes and the settings the web pages added. */
export const ROUTES: readonly RouteSpec[] = [
  ...postingRoutes,
  ...scoreRoutes,
  ...dispositionRoutes,
  ...criteriaRoutes,
  ...registryRoutes,
  ...textRoutes,
  ...statsRoutes,
  ...questionRoutes,
  ...settingsRoutes,
]

/**
 * Mounts every route under `/api`.
 *
 * No credential check is mounted here. The server entry mounts `requireApiAccess` on `/api`
 * before calling this; a second check in this function would test every request twice.
 */
export function mountRoutes(app: Application, db: Db): void {
  const api = Router()
  for (const spec of ROUTES) api[spec.method](spec.path, spec.handler(db))
  app.use('/api', api)
}
