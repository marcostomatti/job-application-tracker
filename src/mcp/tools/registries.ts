import { addRegistryRows, archiveRegistryRow, listRegistry } from '../../data/repositories/registries.ts'
import { RegistryAddBulkSchema, RegistryAddSchema, RegistryArchiveSchema, RegistryListQuerySchema } from '../../schemas/registries.ts'
import type { z } from 'zod'

import type { Db } from '../../data/repositories/db.ts'
import { defineTool, type ToolDefinition } from '../register.ts'

/**
 * Adds the one row of a `registry_add` call and returns it as stored. Exported so the HTTP route
 * that mirrors the tool calls the same function.
 */
export async function addOneRegistryRow(db: Db, input: z.infer<typeof RegistryAddSchema>): Promise<unknown> {
  const [created] = await addRegistryRows(db, input.registry, [input.row])
  if (!created) throw new Error('The registry insert returned no row.')
  return created
}

/** §11.1 group 5: the twelve pick-list registries the user's own vocabulary lives in. */
export const registryTools: ToolDefinition[] = [
  defineTool({
    name: 'registry_list',
    title: 'List a registry',
    description:
      'Lists the rows of ONE registry (a pick-list: phase, stage, route, apply_route, work_format, seniority, layer, penalty_kind, rejection_reason, set_aside_reason, text_type or artefact_kind), in the user\'s own order. ' +
      'Each row carries its id, label and that registry\'s own columns, such as a phase\'s isShortlist or a stage\'s flags. ' +
      'Archived rows are left out because a new write must not pick one; set includeArchived to true to resolve the label of an older reference. ' +
      'The registries ship empty, so an empty list is normal on a fresh install.',
    input: RegistryListQuerySchema,
    run: async (args, db) => listRegistry(db, args.registry, args),
  }),
  defineTool({
    name: 'registry_add',
    title: 'Add a registry row',
    description:
      'Adds ONE row to a registry and returns it with its id. The shape of row depends on registry. ' +
      'apply_route, artefact_kind, penalty_kind, rejection_reason, route, set_aside_reason, text_type and work_format take only a label. ' +
      'seniority takes a label and an optional sort. layer takes a key, a label and an optional sort. phase takes a key, a label, an optional sort and an optional isShortlist flag. ' +
      'stage takes a key, a label, an optional sort, an optional phaseId and the optional flags isTerminal, isRepeatable, isTraction and isApplied. ' +
      'sort is the position in the user\'s own order, and only seniority, layer, phase and stage have one. ' +
      'A field the chosen registry does not have is refused. A key the registry already holds is a conflict. ' +
      'Use registry_add_bulk to add several rows to one registry in one call.',
    input: RegistryAddSchema,
    run: async (args, db) => addOneRegistryRow(db, args),
  }),
  defineTool({
    name: 'registry_add_bulk',
    title: 'Add several registry rows',
    description:
      'Adds up to 500 rows to ONE registry in one call and returns them as stored, in the order given. One call never mixes registries; the registry applies to every item. ' +
      'The items have the same shape as the row of registry_add for that registry. All or none: a duplicate key anywhere in the call writes nothing. ' +
      'Use this to set up a vocabulary in one step instead of repeated registry_add calls.',
    input: RegistryAddBulkSchema,
    run: async (args, db) => addRegistryRows(db, args.registry, args.items),
  }),
  defineTool({
    name: 'registry_archive',
    title: 'Archive a registry row',
    description:
      'Retires ONE registry row and returns it. An archived row stops being offered for new writes but keeps its label, so everything that already references it still renders; it is not deleted. ' +
      'Archiving a row that is already archived changes nothing and returns it as it is, so a repeated call is safe. An unknown id is a not-found error.',
    input: RegistryArchiveSchema,
    run: async (args, db) => archiveRegistryRow(db, args.registry, args.id),
  }),
]
