import {
  createCriteriaVersion,
  getRequirements,
  listCriteriaSets,
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
import { makeDefaultCriteriaSet, readCriteriaMode, writeCriteriaMode } from '../../mcp/tools/criteria.ts'
import { route, type RouteSpec } from './spec.ts'

/**
 * `criteria_requirement_update` names a requirement and nothing else, but the URL also names its
 * set. The set is checked, not ignored: a URL that says set 3 must not change a requirement of
 * set 4. `getRequirements` is `NotFoundError` for a set that is not there.
 *
 * The check and the write run in one transaction, because verifying ownership and then acting on
 * it is a pair that should not be split across two connections' views. Nothing in this codebase
 * re-parents a requirement (the update writes weight, kind, label and anchors only), so the
 * membership the check reads cannot change underneath the write today; the transaction keeps the
 * pair together should that ever change, though without a row lock it is not by itself an
 * exclusion against a concurrent writer.
 */
async function updateRequirementOfSet(
  db: Db,
  criteriaSetId: number,
  input: RequirementUpdateInput,
): Promise<unknown> {
  return db.transaction(async (tx) => {
    const rows = await getRequirements(tx, criteriaSetId)
    if (!rows.some((row) => row.id === input.requirementId)) {
      throw new NotFoundError(`criteria set ${criteriaSetId} requirement`, input.requirementId)
    }
    return updateRequirement(tx, input.requirementId, input.patch)
  })
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
  route('put', '/criteria-sets/:criteriaSetId/default', 'criteria_set_default', CriteriaSetDefaultInputSchema, async (args, db) =>
    makeDefaultCriteriaSet(db, args.criteriaSetId),
  ),
  route('get', '/config/mode', 'criteria_mode_get', EmptyInputSchema, async (_args, db) => readCriteriaMode(db)),
  route('put', '/config/mode', 'criteria_mode_set', CriteriaModeInputSchema, async (args, db) => writeCriteriaMode(db, args.mode)),
]
