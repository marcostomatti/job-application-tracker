/**
 * What the migration lint allows and denies. Extend these lists rather than
 * editing the lint's logic: the rules read them, they do not copy them.
 */

/**
 * The only string literals a CHECK constraint may contain: the members of the
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
 * Words that must not appear in a column name (whole words once the name is
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

/** The twelve registry tables. A migration must never INSERT into one. */
export const REGISTRY_TABLES: readonly string[] = [
  'phase',
  'stage',
  'layer',
  'route',
  'set_aside_reason',
  'rejection_reason',
  'penalty_kind',
  'text_type',
  'artefact_kind',
  'work_format',
  'seniority',
  'apply_route',
]

/**
 * Placeholder for the names in the repo's own `company` table, which does not
 * exist yet. A later plan replaces this constant with a query against that
 * table; until then it holds the fictional name the lint's fixture uses.
 */
export const PLACEHOLDER_COMPANY_NAMES: readonly string[] = ['Globex Corporation']
