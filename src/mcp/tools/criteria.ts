import { createCriteriaVersion, findCriteriaSet, type CriteriaSetRow, getRequirements, listCriteriaSets, setDefaultCriteriaSet, updateRequirement } from '../../data/repositories/criteria.ts'
import { readMode, setMode } from '../../data/repositories/config.ts'
import { EmptyInputSchema } from '../../schemas/common.ts'
import { CriteriaModeInputSchema } from '../../schemas/config.ts'
import {
  CriteriaRequirementsQuerySchema,
  CriteriaSetDefaultInputSchema,
  CriteriaSetQuerySchema,
  CriteriaVersionInputSchema,
  RequirementUpdateInputSchema,
} from '../../schemas/criteria.ts'
import type { CriteriaMode } from '../../schemas/config.ts'
import type { Db } from '../../data/repositories/db.ts'
import { defineTool, type ToolDefinition } from '../register.ts'

/**
 * The three compositions of this group that are more than one repository call. Each is exported
 * so the HTTP route that mirrors the tool calls the same function, and the two cannot disagree
 * about what the call does.
 */

/** Makes a set the default, then returns it as stored. */
export async function makeDefaultCriteriaSet(db: Db, criteriaSetId: number): Promise<CriteriaSetRow> {
  await setDefaultCriteriaSet(db, criteriaSetId)
  return findCriteriaSet(db, criteriaSetId)
}

/** The criteria mode, wrapped as the `{ mode }` both surfaces answer. */
export async function readCriteriaMode(db: Db): Promise<{ mode: CriteriaMode }> {
  return { mode: await readMode(db) }
}

/** Sets the criteria mode and answers it as `{ mode }`. */
export async function writeCriteriaMode(db: Db, mode: CriteriaMode): Promise<{ mode: CriteriaMode }> {
  await setMode(db, mode)
  return { mode }
}

/** §11.1 group 4: criteria sets, their requirements, the default set and the criteria mode. */
export const criteriaTools: ToolDefinition[] = [
  defineTool({
    name: 'criteria_sets',
    title: 'List criteria sets',
    description:
      'Lists the criteria sets (the versioned rubrics that postings are scored against), newest first, each with its name, version, apply threshold and whether it is the default. ' +
      'Archived sets are left out unless includeArchived is true. ' +
      'Use this to find a criteriaSetId; use criteria_requirements to see what is inside one set.',
    input: CriteriaSetQuerySchema,
    run: async (args, db) => listCriteriaSets(db, args),
  }),
  defineTool({
    name: 'criteria_requirements',
    title: 'Get the requirements of a criteria set',
    description:
      'Returns the requirements of ONE criteria set in rubric order: each with its key, label, kind (gate or soft), weight, anchors (what a coverage of 0, 0.5 and 1 mean), layer label and detours. ' +
      'You need these requirement ids and keys to score a posting with score_posting. ' +
      'An unknown set is a not-found error, and a set with no requirements returns an empty list.',
    input: CriteriaRequirementsQuerySchema,
    run: async (args, db) => getRequirements(db, args.criteriaSetId),
  }),
  defineTool({
    name: 'criteria_version_create',
    title: 'Create a new criteria version',
    description:
      'Copies a criteria set, with its requirements, weights, threshold and detours, into a new set and returns it. ' +
      'The version number is assigned for you: one past the highest version of the target name. By default the copy keeps the source\'s name; give name to file it under another, which starts at version 1. ' +
      'The copy is never the default and never archived; use criteria_set_default to promote it. ' +
      'Prefer this to editing a set that has already been used for scoring, so old scores keep their meaning. ' +
      'EXPECT postings to drop out of the recommended-for-apply list: a new version of a name supersedes the older ones at once, and only the newest version of each name counts toward a recommendation, so every posting that was recommended only by the older version stops being recommended until it is scored against the new one. That is deliberate (the new criteria have not been applied yet, so the answer is unknown, not a stale yes). Fix it with rescore_request for the new set, then score each pending posting with score_posting. A copy filed under a different name starts at version 1 and supersedes nothing.',
    input: CriteriaVersionInputSchema,
    run: async (args, db) => createCriteriaVersion(db, args),
  }),
  defineTool({
    name: 'criteria_requirement_update',
    title: 'Update a requirement',
    description:
      'Changes the weight, kind, label or anchors of ONE requirement and returns it as stored; fields left out are kept. ' +
      'A weight is zero or more, and null means no weight is set yet. An empty patch is refused and an unknown requirement is a not-found error. ' +
      'This edits the requirement in place, which changes what existing scores of its set mean; to keep history intact, make a copy with criteria_version_create first.',
    input: RequirementUpdateInputSchema,
    run: async (args, db) => updateRequirement(db, args.requirementId, args.patch),
  }),
  defineTool({
    name: 'criteria_set_default',
    title: 'Set the default criteria set',
    description:
      'Makes ONE criteria set the default and returns it. There is only one default, so the previous one stops being it. ' +
      'The default is the set whose latest score posting_search shows when no criteriaSetId is given. An archived set cannot be the default, and a refused call leaves the current default in place.',
    input: CriteriaSetDefaultInputSchema,
    run: async (args, db) => makeDefaultCriteriaSet(db, args.criteriaSetId),
  }),
  defineTool({
    name: 'criteria_mode_get',
    title: 'Get the criteria mode',
    description:
      'Returns the criteria mode the app runs in, as { mode }: versioned (one active rubric that is revised over time) or perspective (several rubrics side by side). ' +
      'A fresh install is versioned. Takes no arguments.',
    input: EmptyInputSchema,
    run: async (_args, db) => readCriteriaMode(db),
  }),
  defineTool({
    name: 'criteria_mode_set',
    title: 'Set the criteria mode',
    description:
      'Switches the app between the versioned and perspective criteria modes and returns the new { mode }. ' +
      'Changing the mode changes how scores are grouped and shown, not the scores themselves. Use criteria_mode_get to read the current one.',
    input: CriteriaModeInputSchema,
    run: async (args, db) => writeCriteriaMode(db, args.mode),
  }),
]
