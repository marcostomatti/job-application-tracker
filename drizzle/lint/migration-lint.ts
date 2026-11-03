import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import {
  ALLOWED_STRUCTURAL_LITERALS,
  DENIED_COLUMN_WORDS,
  DENIED_SUBSTRINGS,
  EMPTY_VALUE_LITERALS,
  PLACEHOLDER_COMPANY_NAMES,
  SPECIAL_VALUE_LITERALS,
  STRUCTURAL_VALUE_PATTERNS,
} from './forbidden'

/*
 * Known limits, left unscanned on purpose: CREATE DOMAIN and CREATE POLICY
 * bodies, `UPDATE ... SET x = 'literal'` (a backfill is allowed), a view's
 * implicit alias with no AS, a view column list (`CREATE VIEW "v" ("x") AS`),
 * and CTE names. Functions, procedures, triggers
 * and DO blocks are forbidden outright instead (see `routineFindings`).
 */

export type LintRule =
  | 'vocabulary-in-check'
  | 'named-column'
  | 'named-object'
  | 'forbidden-routine'
  | 'registry-seed'
  | 'leaky-comment'
  | 'pack-carries-judgement'

export type LintFinding = {
  file: string
  line: number
  rule: LintRule
  detail: string
}

export type LintOptions = {
  /** Names the leaky-comment rule rejects. Defaults to the placeholder list. */
  companyNames?: readonly string[]
}

type SplitSql = {
  /** The SQL with every comment blanked out; strings and layout are kept. */
  code: string
  /** Only the comments; everything else blanked out. Layout is kept. */
  comments: string
}

/**
 * A Postgres dollar-quote tag: `$$`, or `$tag$` where the tag starts with a
 * letter (any letter, so non-ASCII too) or underscore and may continue with
 * digits. `$1$` is not a tag. This is the only copy of the class; every
 * pattern that reads dollar quotes builds on it.
 */
const DOLLAR_TAG = String.raw`\$(?:[A-Za-z_\u0080-\uFFFF][A-Za-z0-9_\u0080-\uFFFF]*)?\$`
const DOLLAR_TAG_AT_START = new RegExp(`^${DOLLAR_TAG}`)
const COMMENT_ON_OPENER = new RegExp(String.raw`\bCOMMENT\s+ON\s+[^;'$]*?\bIS\s+('|${DOLLAR_TAG})`, 'gi')
const LITERAL = new RegExp(String.raw`'((?:[^']|'')*)'|(${DOLLAR_TAG})([\s\S]*?)\2`, 'g')

const IDENTIFIER = String.raw`"[^"]+"|\w+`
const NON_COLUMN_KEYWORDS = new Set([
  'constraint', 'primary', 'unique', 'check', 'foreign', 'exclude', 'like',
])
const REPO_ROOT = join(import.meta.dir, '..', '..')

const lineOf = (text: string, index: number): number =>
  text.slice(0, index).split('\n').length

const blank = (char: string): string => (char === '\n' ? '\n' : ' ')

/**
 * Separate comments from code in one pass, keeping offsets and line breaks
 * identical in both outputs so a match index maps to the same line in each.
 */
export function splitCodeAndComments(sql: string): SplitSql {
  let code = ''
  let comments = ''
  let i = 0
  while (i < sql.length) {
    const char = sql[i] as string
    const next = sql[i + 1]
    const tag = dollarTagAt(sql, i)
    if (char === '-' && next === '-') {
      const end = sql.indexOf('\n', i)
      const stop = end === -1 ? sql.length : end
      comments += sql.slice(i, stop)
      code += ' '.repeat(stop - i)
      i = stop
    } else if (char === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2)
      const stop = end === -1 ? sql.length : end + 2
      const block = sql.slice(i, stop)
      comments += block
      code += [...block].map(blank).join('')
      i = stop
    } else if (char === "'" || char === '"' || tag) {
      const stop = tag ? endOfLiteral(sql, i) : endOfQuoted(sql, i, char)
      const quoted = sql.slice(i, stop)
      code += quoted
      comments += [...quoted].map(blank).join('')
      i = stop
    } else {
      code += char
      comments += blank(char)
      i += 1
    }
  }
  return { code, comments }
}

/** Index just past the closing quote; a doubled quote is an escaped quote. */
function endOfQuoted(text: string, start: number, quote: string): number {
  let i = start + 1
  while (i < text.length) {
    if (text[i] === quote) {
      if (text[i + 1] === quote) i += 2
      else return i + 1
    } else i += 1
  }
  return text.length
}

/** The `$tag$` that opens a dollar-quoted string at `index`, if one does. */
function dollarTagAt(text: string, index: number): string | undefined {
  if (text[index] !== '$') return undefined
  return DOLLAR_TAG_AT_START.exec(text.slice(index, index + 64))?.[0]
}

/** Index just past the string literal opened at `open`: single-quoted or dollar-quoted. */
function endOfLiteral(text: string, open: number): number {
  const tag = dollarTagAt(text, open)
  if (!tag) return endOfQuoted(text, open, "'")
  const close = text.indexOf(tag, open + tag.length)
  return close === -1 ? text.length : close + tag.length
}

/**
 * The code with the inside of every single-quoted and dollar-quoted string
 * blanked, so a string cannot pass for a statement. The quotes and tags stay,
 * and so does every offset.
 */
function blankStrings(code: string): string {
  let result = ''
  let i = 0
  while (i < code.length) {
    const char = code[i] as string
    const tag = dollarTagAt(code, i)
    const stop = tag || char === "'" || char === '"' ? (tag ? endOfLiteral(code, i) : endOfQuoted(code, i, char)) : i + 1
    const piece = code.slice(i, stop)
    if (tag) {
      const closed = piece.length >= tag.length * 2 && piece.endsWith(tag)
      const inner = piece.slice(tag.length, closed ? piece.length - tag.length : undefined)
      result += `${tag}${[...inner].map(blank).join('')}${closed ? tag : ''}`
    } else if (char === "'") {
      const closed = piece.length > 1 && piece.endsWith("'")
      const inner = closed ? piece.slice(1, -1) : piece.slice(1)
      result += `'${[...inner].map(blank).join('')}${closed ? "'" : ''}`
    } else result += piece
    i = stop
  }
  return result
}

/**
 * `COMMENT ON ... IS '...'` (or `IS $tag$...$tag$`) is a comment that lives in
 * a string literal and persists in the database. Write its text into the
 * comments layer, padded so offsets stay aligned with `code`.
 */
function withCommentOnText(code: string, comments: string): string {
  let result = comments
  for (const match of code.matchAll(COMMENT_ON_OPENER)) {
    const delimiter = match[1] as string
    const open = match.index + match[0].length - delimiter.length
    const contentStart = open + delimiter.length
    const close = delimiter === "'" ? endOfQuoted(code, open, "'") - 1 : code.indexOf(delimiter, contentStart)
    const contentEnd = close === -1 ? code.length : close
    const stop = Math.min(code.length, contentEnd + delimiter.length)
    const pad = ' '.repeat(delimiter.length)
    result = `${result.slice(0, open)}${pad}${code.slice(contentStart, contentEnd)}${pad}${result.slice(stop)}`
  }
  return result
}

/** Index of the paren closing the one at `open`, skipping quoted text. */
function closingParen(text: string, open: number): number {
  let depth = 0
  let i = open
  while (i < text.length) {
    const char = text[i] as string
    if (char === "'" || char === '"') {
      i = endOfQuoted(text, i, char)
      continue
    }
    if (char === '(') depth += 1
    if (char === ')') {
      depth -= 1
      if (depth === 0) return i
    }
    i += 1
  }
  return text.length
}

/** Split a parenthesised body at its top-level commas, keeping each start. */
function topLevelItems(text: string, from: number, to: number): { start: number; text: string }[] {
  const items: { start: number; text: string }[] = []
  let depth = 0
  let start = from
  let i = from
  while (i < to) {
    const char = text[i] as string
    if (char === "'" || char === '"') {
      i = endOfQuoted(text, i, char)
      continue
    }
    if (char === '(') depth += 1
    if (char === ')') depth -= 1
    if (char === ',' && depth === 0) {
      items.push({ start, text: text.slice(start, i) })
      start = i + 1
    }
    i += 1
  }
  items.push({ start, text: text.slice(start, to) })
  return items
}

const unquote = (identifier: string): string => identifier.replace(/^"|"$/g, '')

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
    const value = literal[1] ?? literal[3] ?? ''
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
  const literalStart = String.raw`(?=['$])`
  const values: [RegExp, string][] = [
    [new RegExp(String.raw`\bADD\s+VALUE\s+(?:IF\s+NOT\s+EXISTS\s+)?${literalStart}`, 'gi'), 'ADD VALUE'],
    [
      new RegExp(
        String.raw`\bRENAME\s+VALUE\s+(?:'[^']*'|${DOLLAR_TAG}[^$]*${DOLLAR_TAG})\s+TO\s+${literalStart}`,
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

/** Index of the next top-level `;`, skipping quoted text, or the end of the text. */
function endOfStatement(text: string, from: number): number {
  let i = from
  while (i < text.length) {
    const char = text[i] as string
    if (char === "'" || char === '"') i = endOfQuoted(text, i, char)
    else if (char === ';') return i
    else i += 1
  }
  return text.length
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
const CREATE_INDEX_OR_VIEW = new RegExp(String.raw`\bCREATE\s+${CREATE_MODIFIERS}(INDEX|VIEW)\b`, 'gi')

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
  for (const match of stringless.matchAll(CREATE_INDEX_OR_VIEW)) {
    const construct = (match[1] as string).toUpperCase()
    spans.push({ construct, from: match.index, to: endOfStatement(stringless, match.index) })
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
      String.raw`\bCREATE\s+${CREATE_MODIFIERS}(TABLE|INDEX|TYPE|VIEW|SEQUENCE|SCHEMA)\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(${QUALIFIED_NAME})`,
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
 * A view's output aliases (`AS "name"`) are column names the view exposes, so
 * they get the same denied-word check as a column. Drizzle emits `as "alias"`.
 */
function viewAliasFindings(stringless: string, file: string): LintFinding[] {
  const findings: LintFinding[] = []
  for (const view of stringless.matchAll(new RegExp(String.raw`\bCREATE\s+${CREATE_MODIFIERS}VIEW\b`, 'gi'))) {
    const end = endOfStatement(stringless, view.index)
    const body = stringless.slice(view.index, end)
    for (const alias of body.matchAll(new RegExp(String.raw`\bAS\s+(${IDENTIFIER})`, 'gi'))) {
      const name = unquote(alias[1] as string)
      const word = NOT_ALIASES.has(name.toLowerCase()) ? undefined : deniedWord(name)
      if (word) {
        findings.push({
          file,
          line: lineOf(stringless, view.index + alias.index + alias[0].length - (alias[1] as string).length),
          rule: 'named-column',
          detail: `view alias "${name}" is named after "${word}"`,
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

/** Words of a name, with camelCase boundaries split before lowercasing. */
function nameWords(columnName: string): string[] {
  return columnName
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

function deniedWord(columnName: string): string | undefined {
  const byWord = nameWords(columnName).find((word) =>
    DENIED_COLUMN_WORDS.includes(word) || DENIED_COLUMN_WORDS.includes(word.replace(/s$/, '')),
  )
  return byWord ?? DENIED_SUBSTRINGS.find((fragment) => columnName.toLowerCase().includes(fragment))
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
  return findings
}

type CommentRun = { text: string; lineAt: number[] }

/**
 * Normalise comments for matching: strip the comment markers and leading
 * stars, collapse whitespace, and join consecutive comment lines into one
 * text, so a count or a name wrapped across lines still reads as one phrase.
 * `lineAt[i]` is the source line of character `i` of the text.
 */
function commentRuns(comments: string): CommentRun[] {
  const runs: CommentRun[] = []
  let current: CommentRun | undefined
  comments.split('\n').forEach((raw, offset) => {
    const cleaned = raw
      .replace(/\/\*|\*\/|--/g, ' ')
      .replace(/^\s*\*+/, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (!cleaned) {
      current = undefined
      return
    }
    if (!current) {
      current = { text: '', lineAt: [] }
      runs.push(current)
    }
    current.text += `${cleaned} `
    current.lineAt.push(...Array.from({ length: cleaned.length + 1 }, () => offset + 1))
  })
  return runs
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * A count such as "93 rows", "10k rows", "1.2M rows", "93 records" or "93
 * entries": the number and the noun are adjacent. A "3." list marker is not a
 * number here, because a number's decimal point must be followed by digits.
 */
const ROW_COUNT = /(?<![\w.])\d+(?:[.,]\d+)*\s*(?:k|m|thousand|million|billion)?\s*(?:rows?|records?|entries)\b/gi

function commentFindings(comments: string, file: string, companyNames: readonly string[]): LintFinding[] {
  const findings: LintFinding[] = []
  for (const run of commentRuns(comments)) {
    for (const match of run.text.matchAll(ROW_COUNT)) {
      findings.push({
        file,
        line: run.lineAt[match.index] as number,
        rule: 'leaky-comment',
        detail: `comment cites a row count: "${match[0]}"`,
      })
    }
    for (const name of companyNames) {
      const pattern = new RegExp(String.raw`\b${escapeRegExp(name).replace(/\s+/g, String.raw`\s+`)}\b`, 'gi')
      for (const match of run.text.matchAll(pattern)) {
        findings.push({
          file,
          line: run.lineAt[match.index] as number,
          rule: 'leaky-comment',
          detail: `comment names a company: "${name}"`,
        })
      }
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

/** Lint every `.sql` file directly inside `dir`. A missing directory has no findings. */
export function lintMigrations(dir: string, options: LintOptions = {}): LintFinding[] {
  const companyNames = options.companyNames ?? PLACEHOLDER_COMPANY_NAMES
  return filesWithExtension(dir, '.sql').flatMap((name) => {
    const file = join(dir, name)
    const split = splitCodeAndComments(readFileSync(file, 'utf8'))
    const comments = withCommentOnText(split.code, split.comments)
    const stringless = blankStrings(split.code)
    return [
      ...closedSetFindings(split.code, stringless, file),
      ...expressionFindings(split.code, stringless, file),
      ...objectNameFindings(stringless, file),
      ...viewAliasFindings(stringless, file),
      ...routineFindings(stringless, file),
      ...columnFindings(stringless, file),
      ...seedFindings(stringless, file),
      ...commentFindings(comments, file, companyNames),
    ].sort((a, b) => a.line - b.line)
  })
}

/** Lint every `.json` pack directly inside `dir`. Throws on a file that is not valid JSON. */
export function lintVanillaPacks(dir: string): LintFinding[] {
  const judgement = /"(weight|apply_threshold)"\s*:\s*(?!null\b)([^\s,}\]][^,}\]\n]*)/g
  return filesWithExtension(dir, '.json').flatMap((name) => {
    const file = join(dir, name)
    const text = readFileSync(file, 'utf8')
    try {
      JSON.parse(text)
    } catch (error) {
      throw new Error(`${file} is not valid JSON: ${(error as Error).message}`)
    }
    return [...text.matchAll(judgement)].map((match) => ({
      file,
      line: lineOf(text, match.index),
      rule: 'pack-carries-judgement' as const,
      detail: `"${match[1]}" is ${(match[2] as string).trim()}; a vanilla pack carries null`,
    }))
  })
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
  const findings = [
    ...lintMigrations(join(root, 'drizzle')),
    ...lintVanillaPacks(join(root, 'seeds', 'vanilla')),
  ].map((finding) => ({ ...finding, file: relative(root, finding.file) }))
  return { findings, problems: [] }
}

const formatFinding = (finding: LintFinding): string =>
  `${finding.file}:${finding.line} ${finding.rule} — ${finding.detail}`

if (import.meta.main) {
  const { findings, problems } = lintRepo(REPO_ROOT)
  for (const problem of problems) console.error(problem)
  for (const finding of findings) console.log(formatFinding(finding))
  process.exit(findings.length === 0 && problems.length === 0 ? 0 : 1)
}
