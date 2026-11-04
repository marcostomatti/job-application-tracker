import { z } from 'zod'

import { booleanOrText, bulkOf, hasNoNul, IdSchema, NO_NUL_MESSAGE } from './common.ts'

/** Trimmed, non-empty and storable: a blank label names nothing in a pick-list, and NUL is refused. */
const label = z.string().trim().min(1).refine(hasNoNul, NO_NUL_MESSAGE)

/**
 * The stable handle the user chooses, for a seed pack or an import to name a row by.
 * Nothing in the code branches on its value; it is the user's vocabulary, not the
 * program's, which is what the `is*` flags exist to keep out of code. NUL is refused because
 * Postgres cannot store it in text.
 */
const key = z.string().trim().min(1).refine(hasNoNul, NO_NUL_MESSAGE)

/** The user's own order within the registry. Absent leaves the column's own default. */
const sort = z.number().int().optional()

/** The eight registries that carry nothing of their own. */
const LabelRowSchema = z.strictObject({ label })

/** `layer`: named by a pack, and ordered. */
const KeyedRowSchema = z.strictObject({ key, label, sort })

/** `seniority`: ordered, because comparisons between seniorities read `sort`. */
const SortedRowSchema = z.strictObject({ label, sort })

/** `phase`: the board's columns, with the user-set flag for where a recommendation lands. */
const PhaseRowSchema = z.strictObject({
  key,
  label,
  sort,
  isShortlist: z.boolean().optional(),
})

/**
 * `stage`: the flags the pipeline rules read, and the phase it belongs to. `phaseId` is
 * optional and nullable because the phase registry ships empty, so a stage may exist
 * before any phase does.
 */
const StageRowSchema = z.strictObject({
  key,
  label,
  sort,
  phaseId: IdSchema.nullable().optional(),
  isTerminal: z.boolean().optional(),
  isRepeatable: z.boolean().optional(),
  isTraction: z.boolean().optional(),
  isApplied: z.boolean().optional(),
})

/**
 * One schema per registry, keyed by the registry name the surface passes. The registries
 * are not uniform — four carry a `sort`, three a `key`, two the pipeline flags — so an
 * input shape is picked by name rather than shared, and a field a registry does not have
 * is refused rather than quietly dropped.
 */
export const REGISTRY_SCHEMAS = {
  apply_route: LabelRowSchema,
  artefact_kind: LabelRowSchema,
  layer: KeyedRowSchema,
  penalty_kind: LabelRowSchema,
  phase: PhaseRowSchema,
  rejection_reason: LabelRowSchema,
  route: LabelRowSchema,
  seniority: SortedRowSchema,
  set_aside_reason: LabelRowSchema,
  stage: StageRowSchema,
  text_type: LabelRowSchema,
  work_format: LabelRowSchema,
}

/** The registry names the schemas cover; `RegistryName` in the repository is checked against it. */
export type RegistrySchemaName = keyof typeof REGISTRY_SCHEMAS

/** What a caller supplies to add one row to the registry `N`. */
export type RegistryRowInputOf<N extends RegistrySchemaName> = z.infer<(typeof REGISTRY_SCHEMAS)[N]>

/** A row input for some registry, for code that holds one without knowing which. */
export type RegistryRowInput = RegistryRowInputOf<RegistrySchemaName>

/**
 * The twelve registry names, spelled out so a tool's JSON schema lists them. Checked against
 * `REGISTRY_SCHEMAS` by a test, because a name left out here would be a registry no tool can reach.
 */
export const REGISTRY_NAMES = [
  'apply_route',
  'artefact_kind',
  'layer',
  'penalty_kind',
  'phase',
  'rejection_reason',
  'route',
  'seniority',
  'set_aside_reason',
  'stage',
  'text_type',
  'work_format',
] as const satisfies readonly RegistrySchemaName[]

const RegistryNameSchema = z.enum(REGISTRY_NAMES)

/** Which registry a list reads, and whether it includes the rows that were archived. */
export const RegistryListQuerySchema = z.strictObject({
  registry: RegistryNameSchema,
  includeArchived: booleanOrText.optional(),
})

export type RegistryListQuery = z.infer<typeof RegistryListQuerySchema>

/** A row of the registry `N` together with the name that says which registry it is for. */
function oneRowFor<N extends RegistrySchemaName>(name: N): z.ZodObject<{ registry: z.ZodLiteral<N>; row: (typeof REGISTRY_SCHEMAS)[N] }, z.core.$strict> {
  return z.strictObject({ registry: z.literal(name), row: REGISTRY_SCHEMAS[name] })
}

/** The same for a bounded array of rows, built on `bulkOf` so the cap and the envelope are shared. */
function manyRowsFor<N extends RegistrySchemaName, S extends z.ZodType>(
  name: N,
  row: S,
): z.ZodObject<{ items: z.ZodArray<S>; registry: z.ZodLiteral<N> }, z.core.$strict> {
  return bulkOf(row).extend({ registry: z.literal(name) })
}

/**
 * One row for one registry. The registry name picks the row's schema, so a row that does
 * not fit its registry (a phase without a key, a route with a sort) and a registry that does
 * not exist are both refused here, before the repository is reached.
 */
export const RegistryAddSchema = z.discriminatedUnion('registry', [
  oneRowFor('apply_route'),
  oneRowFor('artefact_kind'),
  oneRowFor('layer'),
  oneRowFor('penalty_kind'),
  oneRowFor('phase'),
  oneRowFor('rejection_reason'),
  oneRowFor('route'),
  oneRowFor('seniority'),
  oneRowFor('set_aside_reason'),
  oneRowFor('stage'),
  oneRowFor('text_type'),
  oneRowFor('work_format'),
])

/** Up to `BULK_MAX` rows for one registry; one call never mixes registries, so the write is one insert. */
export const RegistryAddBulkSchema = z.discriminatedUnion('registry', [
  manyRowsFor('apply_route', REGISTRY_SCHEMAS.apply_route),
  manyRowsFor('artefact_kind', REGISTRY_SCHEMAS.artefact_kind),
  manyRowsFor('layer', REGISTRY_SCHEMAS.layer),
  manyRowsFor('penalty_kind', REGISTRY_SCHEMAS.penalty_kind),
  manyRowsFor('phase', REGISTRY_SCHEMAS.phase),
  manyRowsFor('rejection_reason', REGISTRY_SCHEMAS.rejection_reason),
  manyRowsFor('route', REGISTRY_SCHEMAS.route),
  manyRowsFor('seniority', REGISTRY_SCHEMAS.seniority),
  manyRowsFor('set_aside_reason', REGISTRY_SCHEMAS.set_aside_reason),
  manyRowsFor('stage', REGISTRY_SCHEMAS.stage),
  manyRowsFor('text_type', REGISTRY_SCHEMAS.text_type),
  manyRowsFor('work_format', REGISTRY_SCHEMAS.work_format),
])

/** The row to retire, named by registry and id. */
export const RegistryArchiveSchema = z.strictObject({
  registry: RegistryNameSchema,
  id: IdSchema,
})

export type RegistryArchiveInput = z.infer<typeof RegistryArchiveSchema>
