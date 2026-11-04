import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import { commentFindings } from './comment-rules'
import {
  ALLOWED_STRUCTURAL_LITERALS,
  EMPTY_VALUE_LITERALS,
  PLACEHOLDER_COMPANY_NAMES,
  SPECIAL_VALUE_LITERALS,
  STRUCTURAL_VALUE_PATTERNS,
} from './forbidden'
import {
  blankStrings,
  closingParen,
  DOLLAR_TAG,
  endOfLiteral,
  endOfQuoted,
  endOfStatement,
  IDENTIFIER,
  lineOf,
  LITERAL,
  splitCodeAndComments,
  topLevelItems,
  unquote,
  withCommentOnText,
} from './sql-text'
import type { LintFinding, LintOptions } from './types'
import { deniedWord } from './words'

export type { LintFinding, LintOptions, LintRule } from './types'

/*
 * Known limits, left unscanned on purpose: CREATE DOMAIN and CREATE POLICY
 * bodies, `UPDATE ... SET x = 'literal'` (a backfill is allowed), a view's
 * implicit alias with no AS, a view column list (`CREATE VIEW "v" ("x") AS`),
 * CTE names, `SELECT ... INTO newtable` (a different statement shape from
 * CREATE TABLE AS), and a denied word glued into a longer
 * word inside a comment (comments are matched on whole words only). Functions, procedures, triggers
 * and DO blocks are forbidden outright instead (see `routineFindings`).
 */

const NON_COLUMN_KEYWORDS = new Set([
  'constraint', 'primary', 'unique', 'check', 'foreign', 'exclude', 'like',
])
const REPO_ROOT = join(import.meta.dir, '..', '..')

type Literal = { value: string; index: number }

const isDiscriminator = (value: string): boolean => ALLOWED_STRUCTURAL_LITERALS.includes(value)

/** A discriminator, an empty value, a quoted number or a date: nothing a user would have to rename. */
const isStructuralValue = (value: string): boolean =>
  isDiscriminator(value) ||
  EMPTY_VALUE_LITERALS.includes(value) ||
  SPECIAL_VALUE_LITERALS.includes(value) ||
  STRUCTURAL_VALUE_PATTERNS.some((pattern) => pattern.test(value))

/** Every single-quoted or dollar-quoted literal in `text[from, to)` that `isAllowed` rejects. */
function vocabularyLiterals(
  text: string,
  from: number,
  to: number,
  isAllowed: (value: string) => boolean = isDiscriminator,
): Literal[] {
  const offending: Literal[] = []
  for (const literal of text.slice(from, to).matchAll(LITERAL)) {
    const value = literal[1] ?? literal[2] ?? literal[4] ?? ''
    if (!isAllowed(value)) offending.push({ value, index: from + literal.index })
  }
  return offending
}

function vocabularyFinding(file: string, code: string, construct: string, offending: Literal[]): LintFinding[] {
  const first = offending[0]
  if (!first) return []
  return [{
    file,
    line: lineOf(code, first.index),
    rule: 'vocabulary-in-check',
    detail: `${construct} lists non-structural literals: ${offending.map((o) => `'${o.value}'`).join(', ')}`,
  }]
}

/**
 * The closed sets: `CHECK (...)` bodies, `CREATE TYPE ... AS ENUM (...)`
 * bodies, `ALTER TYPE ... ADD VALUE '...'` and `RENAME VALUE ... TO '...'`.
 * Drizzle's `pgEnum` emits the enum forms, so they hold vocabulary just as a
 * CHECK does. Positions come from `stringless`, literals from `code`.
 */
function closedSetFindings(code: string, stringless: string, file: string): LintFinding[] {
  const findings: LintFinding[] = []
  const openers: [RegExp, string][] = [[/\bCHECK\s*\(/gi, 'CHECK'], [/\bENUM\s*\(/gi, 'ENUM']]
  for (const [pattern, construct] of openers) {
    for (const match of stringless.matchAll(pattern)) {
      const open = match.index + match[0].length - 1
      const offending = vocabularyLiterals(code, open, closingParen(stringless, open) + 1)
      findings.push(...vocabularyFinding(file, code, construct, offending))
    }
  }
  const literalStart = String.raw`(?=[eE]?['$])`
  const values: [RegExp, string][] = [
    [new RegExp(String.raw`\bADD\s+VALUE\s+(?:IF\s+NOT\s+EXISTS\s+)?${literalStart}`, 'gi'), 'ADD VALUE'],
    [
      new RegExp(
        String.raw`\bRENAME\s+VALUE\s+(?:[eE]?'[^']*'|${DOLLAR_TAG}[^$]*${DOLLAR_TAG})\s+TO\s+${literalStart}`,
        'gi',
      ),
      'RENAME VALUE',
    ],
  ]
  for (const [pattern, construct] of values) {
    for (const match of stringless.matchAll(pattern)) {
      const open = match.index + match[0].length
      const offending = vocabularyLiterals(code, open, endOfLiteral(stringless, open))
      findings.push(...vocabularyFinding(file, code, construct, offending))
    }
  }
  return findings
}

const DEFAULT_STOP = /^(?:NOT|NULL|CONSTRAINT|CHECK|REFERENCES|UNIQUE|PRIMARY|GENERATED|COLLATE|ON)\b/i

/** Where a DEFAULT expression ends: a top-level comma, `;`, unmatched `)` or the next column-option keyword. */
function endOfDefault(text: string, from: number): number {
  let depth = 0
  let i = from
  while (i < text.length) {
    const char = text[i] as string
    if (char === "'" || char === '"') {
      i = endOfQuoted(text, i, char)
      continue
    }
    if (char === '(') depth += 1
    else if (char === ')') {
      if (depth === 0) return i
      depth -= 1
    } else if (depth === 0 && (char === ',' || char === ';')) return i
    else if (depth === 0 && /\s/.test(text[i - 1] ?? '') && DEFAULT_STOP.test(text.slice(i, i + 12))) return i
    i += 1
  }
  return text.length
}

type Span = { construct: string; from: number; to: number }

/** Words that may sit between CREATE and the object kind. */
const CREATE_MODIFIERS = String.raw`(?:(?:OR\s+REPLACE|GLOBAL|LOCAL|TEMP|TEMPORARY|UNLOGGED|RECURSIVE|UNIQUE|MATERIALIZED)\s+)*`
const CREATE_INDEX = new RegExp(String.raw`\bCREATE\s+${CREATE_MODIFIERS}INDEX\b`, 'gi')
const CREATE_VIEW = new RegExp(String.raw`\bCREATE\s+${CREATE_MODIFIERS}VIEW\b`, 'gi')
const CREATE_TABLE = new RegExp(String.raw`\bCREATE\s+${CREATE_MODIFIERS}TABLE\b`, 'gi')

type DerivedStatement = { kind: 'VIEW' | 'CREATE TABLE AS'; from: number; to: number }

/**
 * Whether a CREATE TABLE statement is `... AS <query>`: the first `AS` outside
 * every parenthesis (so a column's `GENERATED ALWAYS AS (...)` is not one),
 * followed by `SELECT`, `WITH`, `VALUES`, `EXECUTE` or a parenthesised query.
 */
function isTableAsQuery(text: string, from: number, to: number): boolean {
  let depth = 0
  let i = from
  while (i < to) {
    const char = text[i] as string
    if (char === "'" || char === '"') {
      i = endOfQuoted(text, i, char)
      continue
    }
    if (char === '(') depth += 1
    else if (char === ')') depth -= 1
    else if (depth === 0 && /^AS\b/i.test(text.slice(i, i + 3)) && !/\w/.test(text[i - 1] ?? '')) {
      return /^AS\s*(?:\(|(?:SELECT|WITH|VALUES|EXECUTE)\b)/i.test(text.slice(i, i + 40))
    }
    i += 1
  }
  return false
}

/** Statements whose body is a query: `CREATE VIEW` and `CREATE TABLE ... AS <query>`. */
function derivedStatements(stringless: string): DerivedStatement[] {
  const found: DerivedStatement[] = []
  for (const match of stringless.matchAll(CREATE_VIEW)) {
    found.push({ kind: 'VIEW', from: match.index, to: endOfStatement(stringless, match.index) })
  }
  for (const match of stringless.matchAll(CREATE_TABLE)) {
    const to = endOfStatement(stringless, match.index)
    if (isTableAsQuery(stringless, match.index + match[0].length, to)) {
      found.push({ kind: 'CREATE TABLE AS', from: match.index, to })
    }
  }
  return found
}

/** Where an expression ends: a top-level comma, `;` or unmatched `)`. */
function endOfAction(text: string, from: number): number {
  let depth = 0
  let i = from
  while (i < text.length) {
    const char = text[i] as string
    if (char === "'" || char === '"') {
      i = endOfQuoted(text, i, char)
      continue
    }
    if (char === '(') depth += 1
    else if (char === ')') {
      if (depth === 0) return i
      depth -= 1
    } else if (depth === 0 && (char === ',' || char === ';')) return i
    i += 1
  }
  return text.length
}

/**
 * Expressions that can carry a literal without being a CHECK or an enum: a
 * column DEFAULT, a GENERATED ... AS (...) expression, and the whole of a
 * CREATE INDEX (its WHERE predicate) or CREATE VIEW statement. Drizzle's
 * `.default('x')` and `index().where(...)` emit exactly these.
 * Positions are found in `stringless` (so a string cannot pass for syntax)
 * and the literals are read from `code`; both have the same offsets.
 */
function expressionFindings(code: string, stringless: string, file: string): LintFinding[] {
  const spans: Span[] = []
  for (const match of stringless.matchAll(/\bDEFAULT\b/gi)) {
    const from = match.index + match[0].length
    spans.push({ construct: 'DEFAULT', from, to: endOfDefault(stringless, from) })
  }
  for (const match of stringless.matchAll(/\bGENERATED\s+ALWAYS\s+AS\s*\(/gi)) {
    const open = match.index + match[0].length - 1
    spans.push({ construct: 'GENERATED', from: open, to: closingParen(stringless, open) + 1 })
  }
  for (const match of stringless.matchAll(CREATE_INDEX)) {
    spans.push({ construct: 'INDEX', from: match.index, to: endOfStatement(stringless, match.index) })
  }
  for (const statement of derivedStatements(stringless)) spans.push({ construct: statement.kind, ...statement })
  // ALTER COLUMN ... TYPE ... USING <expr> maps old values onto new ones.
  for (const match of stringless.matchAll(/\bUSING\b/gi)) {
    const head = stringless.slice(stringless.lastIndexOf(';', match.index) + 1, match.index)
    if (!/^\s*ALTER\b/i.test(head)) continue
    const from = match.index + match[0].length
    spans.push({ construct: 'USING', from, to: endOfAction(stringless, from) })
  }
  return spans.flatMap((span) =>
    vocabularyFinding(file, code, span.construct, vocabularyLiterals(code, span.from, span.to, isStructuralValue)),
  )
}

const QUALIFIED_NAME = String.raw`(?:${IDENTIFIER})(?:\s*\.\s*(?:${IDENTIFIER}))*`

/** Patterns whose last group is an object name; `kind` is fixed, or read from group 1. */
const OBJECT_NAME_PATTERNS: { pattern: RegExp; kind?: string }[] = [
  {
    pattern: new RegExp(
      String.raw`\bCREATE\s+${CREATE_MODIFIERS}(TABLE|INDEX|TYPE|VIEW|SEQUENCE|SCHEMA|DOMAIN)\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(${QUALIFIED_NAME})`,
      'gi',
    ),
  },
  { pattern: new RegExp(String.raw`\bCONSTRAINT\s+(${QUALIFIED_NAME})`, 'gi'), kind: 'constraint' },
  { pattern: new RegExp(String.raw`\bRENAME\s+TO\s+(${QUALIFIED_NAME})`, 'gi'), kind: 'renamed object' },
  {
    pattern: new RegExp(String.raw`\bRENAME\s+CONSTRAINT\s+(?:${IDENTIFIER})\s+TO\s+(${QUALIFIED_NAME})`, 'gi'),
    kind: 'constraint',
  },
]

/** A table, index, type, view, sequence, schema or constraint named after vocabulary. */
function objectNameFindings(code: string, file: string): LintFinding[] {
  const findings: LintFinding[] = []
  for (const { pattern, kind } of OBJECT_NAME_PATTERNS) {
    for (const match of code.matchAll(pattern)) {
      const name = match[match.length - 1] as string
      const label = kind ?? (match[1] as string).toLowerCase()
      for (const segment of name.match(new RegExp(IDENTIFIER, 'g')) ?? []) {
        const word = deniedWord(unquote(segment))
        if (word) {
          findings.push({
            file,
            line: lineOf(code, match.index + match[0].length - name.length),
            rule: 'named-object',
            detail: `${label} "${unquote(segment)}" is named after "${word}"`,
          })
        }
      }
    }
  }
  return findings
}

const NOT_ALIASES = new Set(['select', 'with', 'values', 'table', 'not', 'materialized'])

/**
 * A view's or a derived table's output aliases (`AS "name"`) are column names
 * it exposes, so they get the same denied-word check as a column. Drizzle
 * emits `as "alias"` in views.
 */
function derivedAliasFindings(stringless: string, file: string): LintFinding[] {
  const findings: LintFinding[] = []
  for (const statement of derivedStatements(stringless)) {
    const body = stringless.slice(statement.from, statement.to)
    for (const alias of body.matchAll(new RegExp(String.raw`\bAS\s+(${IDENTIFIER})`, 'gi'))) {
      const name = unquote(alias[1] as string)
      const word = NOT_ALIASES.has(name.toLowerCase()) ? undefined : deniedWord(name)
      if (word) {
        findings.push({
          file,
          line: lineOf(stringless, statement.from + alias.index + alias[0].length - (alias[1] as string).length),
          rule: 'named-column',
          detail: `${statement.kind === 'VIEW' ? 'view' : 'table'} alias "${name}" is named after "${word}"`,
        })
      }
    }
  }
  return findings
}

/**
 * Functions, procedures, triggers, rules and DO blocks are forbidden, not
 * scanned: a body is arbitrary code, so a vocabulary scan of it is always
 * partial, and a template migration has no need of one.
 */
function routineFindings(code: string, file: string): LintFinding[] {
  const findings: LintFinding[] = []
  const forbidden: [RegExp, (match: RegExpMatchArray) => string][] = [
    [/\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+|EVENT\s+)?(FUNCTION|PROCEDURE|TRIGGER|RULE)\b/gi, (m) => `CREATE ${(m[1] as string).toUpperCase()}`],
    [/\bDO\s+(?:LANGUAGE\s+\w+\s+)?[$']/gi, () => 'DO block'],
  ]
  for (const [pattern, describe] of forbidden) {
    for (const match of code.matchAll(pattern)) {
      findings.push({
        file,
        line: lineOf(code, match.index),
        rule: 'forbidden-routine',
        detail: `${describe(match)} is forbidden in a migration; a body is arbitrary code the lint cannot read`,
      })
    }
  }
  return findings
}

/**
 * Every column a migration introduces: CREATE TABLE items, ALTER TABLE ADD
 * [COLUMN], and RENAME [COLUMN] ... TO. Expects code with strings blanked.
 */
function declaredColumns(code: string): { name: string; index: number }[] {
  const columns: { name: string; index: number }[] = []
  const create = new RegExp(String.raw`\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[^\s(]+\s*\(`, 'gi')
  for (const match of code.matchAll(create)) {
    const open = match.index + match[0].length - 1
    for (const item of topLevelItems(code, open + 1, closingParen(code, open))) {
      const name = item.text.match(new RegExp(String.raw`^\s*(${IDENTIFIER})`))
      if (!name || NON_COLUMN_KEYWORDS.has((name[1] as string).toLowerCase())) continue
      columns.push({ name: unquote(name[1] as string), index: item.start + (name[0].length - (name[1] as string).length) })
    }
  }
  const introduced = [
    new RegExp(String.raw`\bADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(${IDENTIFIER})`, 'gi'),
    new RegExp(String.raw`\bRENAME\s+(?:COLUMN\s+)?(?:${IDENTIFIER})\s+TO\s+(${IDENTIFIER})`, 'gi'),
  ]
  for (const pattern of introduced) {
    for (const match of code.matchAll(pattern)) {
      const name = match[1] as string
      if (!NON_COLUMN_KEYWORDS.has(name.toLowerCase())) {
        columns.push({ name: unquote(name), index: match.index + match[0].length - name.length })
      }
    }
  }
  return columns
}

function columnFindings(code: string, file: string): LintFinding[] {
  const findings: LintFinding[] = []
  for (const column of declaredColumns(code)) {
    const word = deniedWord(column.name)
    if (word) {
      findings.push({
        file,
        line: lineOf(code, column.index),
        rule: 'named-column',
        detail: `column "${column.name}" is named after "${word}"`,
      })
    }
  }
  return findings
}

/** A migration carries structure, never data: any INSERT, MERGE ... THEN INSERT or COPY is a seed. UPDATE stays allowed. */
function seedFindings(code: string, file: string): LintFinding[] {
  const findings: LintFinding[] = []
  const statements: [RegExp, string][] = [
    [/\bINSERT\s+INTO\b/gi, 'INSERT'],
    [/\bTHEN\s+INSERT\b/gi, 'INSERT'],
    [/(?:^|;)\s*COPY\b/gi, 'COPY'],
  ]
  for (const [pattern, keyword] of statements) {
    for (const match of code.matchAll(pattern)) {
      findings.push({
        file,
        line: lineOf(code, match.index + match[0].toUpperCase().lastIndexOf(keyword)),
        rule: 'registry-seed',
        detail: `${keyword} in a migration; migrations carry structure, never seed data`,
      })
    }
  }
  for (const statement of derivedStatements(code)) {
    const body = code.slice(statement.from, statement.to)
    if (statement.kind === 'CREATE TABLE AS' && (!/\bFROM\b/i.test(body) || /\bAS\s*\(?\s*VALUES\b/i.test(body))) {
      findings.push({
        file,
        line: lineOf(code, statement.from),
        rule: 'registry-seed',
        detail: 'CREATE TABLE AS built from constants, not from another table; migrations carry structure, never seed data',
      })
    }
  }
  return findings
}

function filesWithExtension(dir: string, extension: string): string[] {
  try {
    return readdirSync(dir).filter((name) => name.endsWith(extension)).sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/** Split one migration, naming the file when a literal is left open. */
function readSplit(file: string): ReturnType<typeof splitCodeAndComments> {
  try {
    return splitCodeAndComments(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`${file}: ${(error as Error).message}`)
  }
}

/** Lint every `.sql` file directly inside `dir`. A missing directory has no findings.
 * Throws on a file with an unterminated literal: nothing after it could be read. */
export function lintMigrations(dir: string, options: LintOptions = {}): LintFinding[] {
  const companyNames = options.companyNames ?? PLACEHOLDER_COMPANY_NAMES
  return filesWithExtension(dir, '.sql').flatMap((name) => {
    const file = join(dir, name)
    const split = readSplit(file)
    const comments = withCommentOnText(split.code, split.comments)
    const stringless = blankStrings(split.code)
    return [
      ...closedSetFindings(split.code, stringless, file),
      ...expressionFindings(split.code, stringless, file),
      ...objectNameFindings(stringless, file),
      ...derivedAliasFindings(stringless, file),
      ...routineFindings(stringless, file),
      ...columnFindings(stringless, file),
      ...seedFindings(stringless, file),
      ...commentFindings(comments, file, companyNames),
    ].sort((a, b) => a.line - b.line)
  })
}

const JUDGEMENT = /"(weight|apply_threshold)"\s*:\s*(?!null\b)([^\s,}\]][^,}\]\n]*)/g

/** Lint one pack file. Throws on a file that is not valid JSON. */
export function lintPackFile(file: string): LintFinding[] {
  const text = readFileSync(file, 'utf8')
  try {
    JSON.parse(text)
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${(error as Error).message}`)
  }
  return [...text.matchAll(JUDGEMENT)].map((match) => ({
    file,
    line: lineOf(text, match.index),
    rule: 'pack-carries-judgement' as const,
    detail: `"${match[1]}" is ${(match[2] as string).trim()}; a vanilla pack carries null`,
  }))
}

/** Lint every `.json` pack directly inside `dir`. Throws on a file that is not valid JSON. */
export function lintVanillaPacks(dir: string): LintFinding[] {
  return filesWithExtension(dir, '.json').flatMap((name) => lintPackFile(join(dir, name)))
}

export type RepoLint = {
  /** Findings, with file paths relative to `root`. */
  findings: LintFinding[]
  /** Reasons the lint could not do its job; any entry means a failing run. */
  problems: string[]
}

/**
 * Lint a repository checkout: `drizzle/` must exist (a lint that scanned
 * nothing must not pass), while `seeds/vanilla/` is optional until the first
 * pack exists.
 */
export function lintRepo(root: string): RepoLint {
  if (!existsSync(join(root, 'drizzle'))) {
    return { findings: [], problems: [`drizzle/ not found at ${join(root, 'drizzle')}; nothing was linted`] }
  }
  try {
    const findings = [
      ...lintMigrations(join(root, 'drizzle')),
      ...lintVanillaPacks(join(root, 'seeds', 'vanilla')),
    ].map((finding) => ({ ...finding, file: relative(root, finding.file) }))
    return { findings, problems: [] }
  } catch (error) {
    // A file the lint could not read to the end is a failed run, not a clean one.
    if (!(error instanceof Error)) throw error
    return { findings: [], problems: [error.message.replaceAll(`${root}/`, '')] }
  }
}

const formatFinding = (finding: LintFinding): string =>
  `${finding.file}:${finding.line} ${finding.rule} — ${finding.detail}`

if (import.meta.main) {
  const { findings, problems } = lintRepo(REPO_ROOT)
  for (const problem of problems) console.error(problem)
  for (const finding of findings) console.log(formatFinding(finding))
  process.exit(findings.length === 0 && problems.length === 0 ? 0 : 1)
}
