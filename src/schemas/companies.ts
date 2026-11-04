import { z } from 'zod'

import { hasNoNul, IdSchema, NO_NUL_MESSAGE } from './common.ts'

/** Trimmed, non-empty and storable: a blank name says nothing, and NUL is refused. */
const text = z.string().trim().min(1).refine(hasNoNul, NO_NUL_MESSAGE)

/**
 * The fields of a company a caller may change. A new `name` recomputes the key it is matched on;
 * `nameUnresolved` marks the name as a placeholder, or clears that mark once the employer is known.
 */
export const CompanyPatchSchema = z.strictObject({
  name: text.optional(),
  nameUnresolved: z.boolean().optional(),
})

export type CompanyPatch = z.infer<typeof CompanyPatchSchema>

/** A patch and the company it applies to, the id kept apart from the columns. */
export const CompanyUpdateInputSchema = z.strictObject({
  companyId: IdSchema,
  patch: CompanyPatchSchema,
})

export type CompanyUpdateInput = z.infer<typeof CompanyUpdateInputSchema>

/**
 * Two companies that are one employer: the postings of `fromCompanyId` move to `intoCompanyId`,
 * which keeps its own name, and `fromCompanyId` is removed. A company cannot merge into itself.
 */
export const CompanyMergeInputSchema = z
  .strictObject({
    intoCompanyId: IdSchema,
    fromCompanyId: IdSchema,
  })
  .refine((input) => input.intoCompanyId !== input.fromCompanyId, {
    path: ['fromCompanyId'],
    message: 'a company cannot be merged into itself',
  })

export type CompanyMergeInput = z.infer<typeof CompanyMergeInputSchema>
