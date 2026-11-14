import { z } from 'zod'

import { hasNoNul, NO_NUL_MESSAGE } from './common.ts'

/** The `app_config` key the link patterns are stored under. */
export const POSTING_LINK_PATTERNS_KEY = 'posting_link_patterns'

/** How many patterns the setting holds: one per job board or source, so a handful. */
export const POSTING_LINK_PATTERNS_MAX = 20

/** The placeholder a template's id goes into. */
export const POSTING_LINK_ID = '{id}'

const WEB_ADDRESS = /^https?:\/\/[^\s/]+\S*$/i

/**
 * One rule for turning a posting key into a link: a key `<prefix>:<id>` opens the template with
 * `{id}` filled in. The prefix is a plain word, so the colon after it is never ambiguous; the
 * template is a web address, so the link can never run a script.
 */
export const PostingLinkPatternSchema = z.strictObject({
  prefix: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9_.-]{0,31}$/i, 'a prefix is one word of up to 32 letters, digits, dots, dashes or underscores'),
  template: z
    .string()
    .trim()
    .max(500)
    .refine(hasNoNul, NO_NUL_MESSAGE)
    .refine((value) => WEB_ADDRESS.test(value), 'a template must be an http or https address')
    .refine((value) => value.includes(POSTING_LINK_ID), `a template must hold ${POSTING_LINK_ID}, where the id goes`),
})

export type PostingLinkPattern = z.infer<typeof PostingLinkPatternSchema>

/** The whole setting: at most `POSTING_LINK_PATTERNS_MAX` patterns, each prefix named once. */
export const PostingLinkPatternsSchema = z
  .array(PostingLinkPatternSchema)
  .max(POSTING_LINK_PATTERNS_MAX)
  .superRefine((patterns, ctx) => {
    const seen = new Set<string>()
    for (const [index, pattern] of patterns.entries()) {
      const prefix = pattern.prefix.toLowerCase()
      if (seen.has(prefix)) ctx.addIssue({ code: 'custom', path: [index, 'prefix'], message: `the prefix ${pattern.prefix} is named twice` })
      seen.add(prefix)
    }
  })

/**
 * The link a posting key opens under the patterns, or null. The id is everything after the first
 * colon, and it is URL-encoded before it goes into the template, so it cannot move the link to
 * another path, query or host.
 */
export function linkFromKey(postingKey: string, patterns: readonly PostingLinkPattern[]): string | null {
  const key = postingKey.trim()
  const colon = key.indexOf(':')
  if (colon <= 0) return null
  const prefix = key.slice(0, colon).toLowerCase()
  const id = key.slice(colon + 1)
  if (id === '') return null
  const pattern = patterns.find((candidate) => candidate.prefix.toLowerCase() === prefix)
  return pattern === undefined ? null : pattern.template.replaceAll(POSTING_LINK_ID, encodeURIComponent(id))
}
