import { RequirementRulesSchema, type RulePlace } from '../schemas/requirement-rules.ts'

/** The fields of a posting the rules read: nothing an agent has to judge. */
export type RulesPosting = {
  readonly roleTitle: string
  readonly country: string | null
  readonly city: string | null
  readonly workFormat: string | null
}

/** A requirement as the rules pass sees it: its rules as stored, which may be none. */
export type RulesRequirement = {
  readonly id: number
  readonly key: string
  readonly kind: string
  readonly rules: unknown
}

/** One requirement a rule rated 0, and the evidence, which names the rule that fired. */
export type RuleFinding = {
  readonly requirementId: number
  readonly requirementKey: string
  readonly evidence: string
}

const isWordCharacter = (character: string | undefined): boolean => character !== undefined && /[\p{L}\p{M}\p{N}]/u.test(character)

/** The whole character that ends just before `at`, a surrogate pair included. */
const characterBefore = (text: string, at: number): string | undefined => Array.from(text.slice(Math.max(0, at - 2), at)).at(-1)

/** The whole character that starts at `at`, a surrogate pair included. */
function characterAt(text: string, at: number): string | undefined {
  const point = text.codePointAt(at)
  return point === undefined ? undefined : String.fromCodePoint(point)
}

/**
 * Whether `title` holds `term` as a whole word, case aside: the characters on each side of a
 * match are not letters or digits, so a term for one language does not fire inside the name
 * of another that starts the same way. A term may hold spaces and punctuation.
 */
export function titleHolds(title: string, term: string): boolean {
  const haystack = title.toLocaleLowerCase()
  const needle = term.trim().toLocaleLowerCase()
  if (needle === '') return false
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    const before = characterBefore(haystack, at)
    const after = characterAt(haystack, at + needle.length)
    const startsInWord = isWordCharacter(characterAt(needle, 0)) && isWordCharacter(before)
    const endsInWord = isWordCharacter(characterBefore(needle, needle.length)) && isWordCharacter(after)
    if (!startsInWord && !endsInWord) return true
  }
  return false
}

type PlaceAnswer = 'match' | 'no-match' | 'unknown'

const sameText = (left: string, right: string): boolean => left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase()

/** How one allowed place compares with the posting: a named field the posting lacks is unknown. */
function comparePlace(posting: RulesPosting, place: RulePlace): PlaceAnswer {
  let unknown = false
  for (const field of ['country', 'city', 'workFormat'] as const) {
    const wanted = place[field]
    if (wanted === undefined) continue
    const actual = posting[field]
    if (actual === null) unknown = true
    else if (!sameText(actual, wanted)) return 'no-match'
  }
  return unknown ? 'unknown' : 'match'
}

/** What the posting's place fields say, for the evidence of a place that matched nothing. */
function describePlace(posting: RulesPosting): string {
  const parts = [
    posting.country === null ? null : `country ${posting.country}`,
    posting.city === null ? null : `city ${posting.city}`,
    posting.workFormat === null ? null : `work format ${posting.workFormat}`,
  ].filter((part) => part !== null)
  return parts.length === 0 ? 'no place given' : parts.join(', ')
}

/** The finding of one requirement's rules, or null when they rate nothing. */
function findingFor(posting: RulesPosting, requirement: RulesRequirement): RuleFinding | null {
  // Only a gate is rated by rules: a gate at 0 blocks the posting whatever else is rated, while a
  // soft requirement at 0 beside nothing else rated would give a band that means nothing.
  if (requirement.kind !== 'gate') return null
  const parsed = RequirementRulesSchema.safeParse(requirement.rules)
  if (!parsed.success) return null
  const { titleBlocks, place } = parsed.data
  const finding = (evidence: string): RuleFinding => ({ requirementId: requirement.id, requirementKey: requirement.key, evidence })

  const term = titleBlocks?.find((candidate) => titleHolds(posting.roleTitle, candidate))
  if (term !== undefined) return finding(`rules pass: the title holds "${term}"`)

  if (place !== undefined && place.every((allowed) => comparePlace(posting, allowed) === 'no-match')) {
    return finding(`rules pass: ${describePlace(posting)} matches no allowed place`)
  }
  return null
}

/**
 * Every gate the rules rate 0 for one posting, in the order the requirements come. Rules on
 * a soft requirement are kept but rate nothing. Rules that are absent, or that no longer parse, rate nothing, and so does a place the
 * posting's missing fields leave open: the pass only rates what the fields settle, and
 * leaves the rest to whoever reads the posting.
 */
export function rulesFindings(posting: RulesPosting, requirements: readonly RulesRequirement[]): RuleFinding[] {
  return requirements.flatMap((requirement) => {
    const found = findingFor(posting, requirement)
    return found === null ? [] : [found]
  })
}
