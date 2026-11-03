import { addRegistryRows, archiveRegistryRow, listRegistry } from '../../data/repositories/registries.ts'
import { RegistryAddSchema, RegistryArchiveSchema, RegistryListQuerySchema } from '../../schemas/registries.ts'
import { route, type RouteSpec } from './spec.ts'

/**
 * The routes over the twelve pick-list registries. The registry is the path's `:registry`, and
 * the schema checks it against the list of names, so no route exists per registry.
 */
export const registryRoutes: readonly RouteSpec[] = [
  route('get', '/registries/:registry', 'registry_list', RegistryListQuerySchema, async (args, db) =>
    listRegistry(db, args.registry, args),
  ),
  route('post', '/registries/:registry', 'registry_add', RegistryAddSchema, async (args, db) => {
    const [created] = await addRegistryRows(db, args.registry, [args.row])
    if (!created) throw new Error('The registry insert returned no row.')
    return created
  }),
  route('patch', '/registries/:registry/:id', 'registry_archive', RegistryArchiveSchema, async (args, db) =>
    archiveRegistryRow(db, args.registry, args.id),
  ),
]
