import { readMode, setMode } from '../../data/repositories/config.ts'
import {
  createCriteriaVersion,
  findCriteriaSet,
  getRequirements,
  listCriteriaSets,
  setDefaultCriteriaSet,
  updateRequirement,
} from '../../data/repositories/criteria.ts'
import type { Db } from '../../data/repositories/db.ts'
import { NotFoundError } from '../../errors.ts'
import { EmptyInputSchema, IdSchema } from '../../schemas/common.ts'
import { CriteriaModeInputSchema } from '../../schemas/config.ts'
import {
  CriteriaRequirementsQuerySchema,
  CriteriaSetDefaultInputSchema,
  CriteriaSetQuerySchema,
  CriteriaVersionInputSchema,
  RequirementUpdateInputSchema,
  type RequirementUpdateInput,
} from '../../schemas/criteria.ts'
import { route, type RouteSpec } from './spec.ts'

/**
 * `criteria_requirement_update` names a requirement and nothing else, but the URL also names its
 * set. The set is checked, not ignored: a URL that says set 3 must not change a requirement of
 * set 4. `getRequirements` is `NotFoundError` for a set that is not there.
 */
async function updateRequirementOfSet(
  db: Db,
  criteriaSetId: number,
  input: RequirementUpdateInput,
): Promise<unknown> {
  const rows = await getRequirements(db, criteriaSetId)
  if (!rows.some((row) => row.id === input.requirementId)) {
    throw new NotFoundError(`criteria set ${criteriaSetId} requirement`, input.requirementId)
  }
  return updateRequirement(db, input.requirementId, input.patch)
}

/** The routes over criteria sets, their requirements, the default set and the criteria mode. */
export const criteriaRoutes: readonly RouteSpec[] = [
  route('get', '/criteria-sets', 'criteria_sets', CriteriaSetQuerySchema, async (args, db) => listCriteriaSets(db, args)),
  route('post', '/criteria-sets', 'criteria_version_create', CriteriaVersionInputSchema, async (args, db) =>
    createCriteriaVersion(db, args),
  ),
  route(
    'get',
    '/criteria-sets/:criteriaSetId/requirements',
    'criteria_requirements',
    CriteriaRequirementsQuerySchema,
    async (args, db) => getRequirements(db, args.criteriaSetId),
  ),
  route(
    'patch',
    '/criteria-sets/:criteriaSetId/requirements/:requirementId',
    'criteria_requirement_update',
    RequirementUpdateInputSchema,
    async (args, db, { criteriaSetId }) => updateRequirementOfSet(db, criteriaSetId, args),
    { pathOnly: { criteriaSetId: IdSchema } },
  ),
  route('put', '/criteria-sets/:criteriaSetId/default', 'criteria_set_default', CriteriaSetDefaultInputSchema, async (args, db) => {
    await setDefaultCriteriaSet(db, args.criteriaSetId)
    return findCriteriaSet(db, args.criteriaSetId)
  }),
  route('get', '/config/mode', 'criteria_mode_get', EmptyInputSchema, async (_args, db) => ({ mode: await readMode(db) })),
  route('put', '/config/mode', 'criteria_mode_set', CriteriaModeInputSchema, async (args, db) => {
    await setMode(db, args.mode)
    return { mode: args.mode }
  }),
]
