import { z } from 'zod'

import { hasNoNul, IdSchema, NO_NUL_MESSAGE, PaginationSchema } from './common.ts'

/**
 * Trimmed and non-empty: a blank name or note says nothing and would only hide a mistake. It
 * also refuses NUL, which Postgres cannot store.
 */
const text = z.string().trim().min(1).refine(hasNoNul, NO_NUL_MESSAGE)

/** A calendar day as `YYYY-MM-DD`, the shape a Postgres `date` column reads and writes. */
const calendarDay = z.iso.date()

/**
 * An employer, as the surface names one. `nameUnresolved` marks a placeholder standing in
 * for an employer not yet known; it is a flag rather than a reserved name so no wording is
 * baked into code.
 */
export const CompanyInputSchema = z.strictObject({
  name: text,
  nameUnresolved: z.boolean().optional(),
})

export type CompanyInput = z.infer<typeof CompanyInputSchema>

/**
 * The columns of a position that a caller may set, whether on creation or in a patch. Each
 * nullable one accepts `null` to mean "no value", and leaves the column alone when absent.
 *
 * `priorityRank` is deliberately not among them. It is the user's own hand-ranking and no
 * import may write it, so only `PositionPatchSchema` carries it: a capture or bulk path
 * built on `PositionInputSchema` cannot set it, because a strict object refuses the key.
 */
const editableFields = {
  seenAt: calendarDay.optional(),
  deadline: calendarDay.nullable().optional(),
  city: text.nullable().optional(),
  country: text.nullable().optional(),
  workFormatId: IdSchema.nullable().optional(),
  seniorityId: IdSchema.nullable().optional(),
  applyRouteId: IdSchema.nullable().optional(),
  salaryRaw: text.nullable().optional(),
  postingAgeRaw: text.nullable().optional(),
  applicantCountRaw: text.nullable().optional(),
  applyContact: text.nullable().optional(),
  clientHidden: z.boolean().optional(),
}

/**
 * Distinguishes two genuinely different roles that share one title at one employer. Blank
 * is its own value, not an absence, so it is trimmed but not required to be non-empty.
 */
const disambiguator = z.string().trim().refine(hasNoNul, NO_NUL_MESSAGE)

/**
 * What a caller supplies to record one position. The employer is named rather than
 * referenced by id, so a capture needs no lookup first and two spellings of one employer
 * reach one company row. `positionKey` is the stable handle for the role; left out, it is
 * derived from the employer and the role, which is what makes a repost the same position.
 */
export const PositionInputSchema = z.strictObject({
  company: CompanyInputSchema,
  roleTitle: text,
  disambiguator: disambiguator.optional(),
  positionKey: text.optional(),
  ...editableFields,
})

export type PositionInput = z.infer<typeof PositionInputSchema>

/**
 * A change to one position. It carries the role title and disambiguator, whose normalised
 * form the repository keeps in step, and the user's hand-ranking, which is accepted here and
 * nowhere else. The employer and the key do not change after creation: a position moved to
 * another employer is a different role. An empty patch names nothing to change, which is a
 * mistake worth reporting.
 */
export const PositionPatchSchema = z
  .strictObject({
    roleTitle: text.optional(),
    disambiguator: disambiguator.optional(),
    priorityRank: z.number().int().nullable().optional(),
    ...editableFields,
  })
  .refine((patch) => Object.values(patch).some((value) => value !== undefined), {
    message: 'a patch must name at least one field to change',
  })

export type PositionPatch = z.infer<typeof PositionPatchSchema>

/**
 * A boolean that may arrive as text, because a query string carries strings while an MCP
 * call carries JSON booleans. Only the two words are accepted, so `1` and `yes` are refused.
 */
const booleanOrText = z.union([z.boolean(), z.enum(['true', 'false']).transform((value) => value === 'true')])

/**
 * Which positions of one kind a search returns, for the two flags that take a row out of the
 * default view: set-aside and client-hidden. Hiding them is the default because a search for
 * leads should not re-offer what the user already passed on or hid; the board asks for
 * `include` because it still draws set-aside cards, and `only` reads just that bucket.
 */
export const VISIBILITY_FILTERS = ['exclude', 'include', 'only'] as const

/**
 * What a board or grid asks of the position list: the filters, then the page. Built on
 * `PaginationSchema.extend` so it stays strict, and a filter name that does not exist is
 * refused instead of dropped.
 *
 * `criteriaSetId` names which set's latest score a row carries and `recommendApply` is
 * tested against; left out, it is the default set. A position with no score under that set
 * matches neither answer to `recommendApply`.
 */
export const PositionQuerySchema = PaginationSchema.extend({
  companyId: IdSchema.optional(),
  phaseId: IdSchema.optional(),
  criteriaSetId: IdSchema.optional(),
  recommendApply: booleanOrText.optional(),
  setAside: z.enum(VISIBILITY_FILTERS).default('exclude'),
  clientHidden: z.enum(VISIBILITY_FILTERS).default('exclude'),
})

export type PositionQuery = z.infer<typeof PositionQuerySchema>
