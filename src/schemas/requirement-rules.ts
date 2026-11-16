import { z } from 'zod'

import { hasNoNul, NO_NUL_MESSAGE } from './common.ts'

/** The most terms or places one requirement's rules may list. */
export const RULE_ITEMS_MAX = 50

/** The longest term or place field a rule keeps. */
export const RULE_TEXT_MAX_CHARS = 80

const ruleText = z.string().trim().min(1).max(RULE_TEXT_MAX_CHARS).refine(hasNoNul, NO_NUL_MESSAGE)

/**
 * One allowed place. Each field it names must equal the posting's own, case aside, and a
 * field it leaves out allows anything. An entry names at least one field, because an empty
 * entry would allow every posting and make the rule say nothing.
 */
export const RulePlaceSchema = z
  .strictObject({
    country: ruleText.optional(),
    city: ruleText.optional(),
    workFormat: ruleText.optional().describe('A work format label as the registry names it, such as the one for remote work.'),
  })
  .refine((place) => Object.values(place).some((value) => value !== undefined), {
    message: 'a place names at least one of country, city or workFormat',
  })

export type RulePlace = z.infer<typeof RulePlaceSchema>

/**
 * The rules that let the server rate one gate from a posting's own fields, with no agent; on
 * a soft requirement they are kept and rate nothing. `titleBlocks` rates the gate 0 when the
 * role title holds one of its terms as a whole word. `place` lists the places allowed: a
 * posting that, by the fields it has, can match none of them is rated 0. A posting the rules cannot decide is left unrated. The rules
 * are the user's own and live with the criteria set, so the repository holds none.
 */
export const RequirementRulesSchema = z
  .strictObject({
    titleBlocks: z.array(ruleText).min(1).max(RULE_ITEMS_MAX).optional()
      .describe('Terms that rate the requirement 0 when the role title holds one as a whole word, case aside.'),
    place: z.array(RulePlaceSchema).min(1).max(RULE_ITEMS_MAX).optional()
      .describe('The places allowed; a posting whose known fields match none of them is rated 0.'),
  })
  .refine((rules) => rules.titleBlocks !== undefined || rules.place !== undefined, {
    message: 'rules name titleBlocks, place or both',
  })

export type RequirementRules = z.infer<typeof RequirementRulesSchema>
