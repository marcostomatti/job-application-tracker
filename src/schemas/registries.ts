import { z } from 'zod'

import { IdSchema } from './common.ts'

/** Trimmed and non-empty: a blank label names nothing in a pick-list. */
const label = z.string().trim().min(1)

/**
 * The stable handle the user chooses, for a seed pack or an import to name a row by.
 * Nothing in the code branches on its value; it is the user's vocabulary, not the
 * program's, which is what the `is*` flags exist to keep out of code.
 */
const key = z.string().trim().min(1)

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
