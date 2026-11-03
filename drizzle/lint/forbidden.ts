/**
 * What the migration lint allows and denies. Extend these lists rather than
 * editing the lint's logic: the rules read them, they do not copy them.
 */

/**
 * The only string literals a CHECK constraint or an enum type may contain: the members of the
 * internal discriminators the code defines, plus the boolean digits.
 * Anything else is vocabulary, and vocabulary belongs in a registry row.
 */
export const ALLOWED_STRUCTURAL_LITERALS: readonly string[] = [
  // requirement.kind
  'gate',
  'soft',
  // disposition outcome
  'set_aside',
  'rejected',
  // rating confidence
  'supported',
  'partial',
  'unknown',
  // trend direction
  'up',
  'down',
  'flat',
  // origin source
  'own_search',
  'inbound',
  'referral',
  'imported_series',
  // booleans stored as integers
  '0',
  '1',
]

/**
 * Values with no vocabulary in them, allowed in a DEFAULT, a GENERATED
 * expression, an index predicate or a view body on top of the structural
 * literals: the empty string and the empty JSON containers. A CHECK stays
 * strict and does not take these.
 */
export const EMPTY_VALUE_LITERALS: readonly string[] = ['', '{}', '[]']

/**
 * Literal shapes that cannot carry vocabulary: a number quoted as a string
 * (Drizzle writes `numeric().default('0.5')` that way) and an ISO date or
 * timestamp.
 */
export const STRUCTURAL_VALUE_PATTERNS: readonly RegExp[] = [
  /^-?\d+(?:\.\d+)?$/,
  /^\d{4}-\d{2}-\d{2}(?:[ T][\d:.+\-Z]+)?$/,
]

/**
 * Words that must not appear in a column, table, index, type or constraint name (whole words once the name is
 * split on underscores; a trailing plural "s" is ignored). Industries,
 * technologies, spoken languages and jurisdictions. The first two entries are
 * the ones the old schema's audit found; the rest are the same kinds of word.
 */
export const DENIED_COLUMN_WORDS: readonly string[] = [
  // named in the design's section 1 audit
  'fintech',
  'acme',
  // industries
  'healthtech',
  'edtech',
  'insurtech',
  'proptech',
  'crypto',
  'blockchain',
  'gambling',
  'defence',
  'defense',
  'ecommerce',
  // technologies
  'angular',
  'elixir',
  'react',
  'vue',
  'svelte',
  'typescript',
  'javascript',
  'python',
  'java',
  'kotlin',
  'golang',
  'rust',
  'php',
  'ruby',
  'dotnet',
  // spoken languages
  'swedish',
  'icelandic',
  'english',
  'german',
  'french',
  'spanish',
  'portuguese',
  'dutch',
  'norwegian',
  'danish',
  'finnish',
  // jurisdictions
  'sweden',
  'norway',
  'denmark',
  'finland',
  'germany',
  'france',
  'spain',
  'portugal',
  'brazil',
  'europe',
  'schengen',
  'usa',
]

/**
 * Denied words long and specific enough that they have no innocent
 * superstring, so they are also matched anywhere inside a name. This is what
 * catches `penaltyfintech`, where there is no word boundary to split on.
 * Short words such as "java", "rust" or "usa" stay whole-word only, because
 * "trust" and "usage" are fine column names.
 */
export const DENIED_SUBSTRINGS: readonly string[] = [
  'fintech',
  'acme',
  'healthtech',
  'edtech',
  'insurtech',
  'proptech',
  'blockchain',
  'ecommerce',
  'typescript',
  'javascript',
  'swedish',
  'icelandic',
  'portuguese',
  'norwegian',
  'schengen',
]

/**
 * Placeholder for the names in the repo's own `company` table, which does not
 * exist yet. A later plan replaces this constant with a query against that
 * table; until then it holds the fictional name the lint's fixture uses.
 */
export const PLACEHOLDER_COMPANY_NAMES: readonly string[] = ['Globex Corporation']
