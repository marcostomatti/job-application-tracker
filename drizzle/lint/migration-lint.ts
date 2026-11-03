import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import {
  ALLOWED_STRUCTURAL_LITERALS,
  DENIED_COLUMN_WORDS,
  DENIED_SUBSTRINGS,
  PLACEHOLDER_COMPANY_NAMES,
} from './forbidden'

export type LintRule =
  | 'vocabulary-in-check'
  | 'named-column'
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
    } else if (char === "'" || char === '"') {
      const stop = endOfQuoted(sql, i, char)
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

/** The code with the inside of every single-quoted string blanked, so a string cannot pass for a statement. */
function blankStrings(code: string): string {
  let result = ''
  let i = 0
  while (i < code.length) {
    const char = code[i] as string
    const stop = char === "'" || char === '"' ? endOfQuoted(code, i, char) : i + 1
    const piece = code.slice(i, stop)
    if (char === "'") {
      const closed = piece.length > 1 && piece.endsWith("'")
      const inner = closed ? piece.slice(1, -1) : piece.slice(1)
      result += `'${[...inner].map(blank).join('')}${closed ? "'" : ''}`
    } else result += piece
    i = stop
  }
  return result
}

/**
 * `COMMENT ON ... IS '...'` is a comment that lives in a string literal and
 * persists in the database. Write its text into the comments layer.
 */
function withCommentOnText(code: string, comments: string): string {
  let result = comments
  for (const match of code.matchAll(/\bCOMMENT\s+ON\s+[^;']*?\bIS\s+'/gi)) {
    const open = match.index + match[0].length - 1
    const stop = endOfQuoted(code, open, "'")
    result = `${result.slice(0, open)} ${code.slice(open + 1, stop - 1)} ${result.slice(stop)}`
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

/** Every single-quoted literal in `text[from, to)` that is not an allowed structural literal. */
function vocabularyLiterals(text: string, from: number, to: number): Literal[] {
  const offending: Literal[] = []
  for (const literal of text.slice(from, to).matchAll(/'((?:[^']|'')*)'/g)) {
    const value = literal[1] as string
    if (!ALLOWED_STRUCTURAL_LITERALS.includes(value)) offending.push({ value, index: from + literal.index })
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
 * bodies and `ALTER TYPE ... ADD VALUE '...'`. Drizzle's `pgEnum` emits the
 * enum forms, so they hold vocabulary just as a CHECK does.
 */
function closedSetFindings(code: string, file: string): LintFinding[] {
  const findings: LintFinding[] = []
  const openers: [RegExp, string][] = [[/\bCHECK\s*\(/gi, 'CHECK'], [/\bENUM\s*\(/gi, 'ENUM']]
  for (const [pattern, construct] of openers) {
    for (const match of code.matchAll(pattern)) {
      const open = match.index + match[0].length - 1
      const offending = vocabularyLiterals(code, open, closingParen(code, open) + 1)
      findings.push(...vocabularyFinding(file, code, construct, offending))
    }
  }
  for (const match of code.matchAll(/\bADD\s+VALUE\s+(?:IF\s+NOT\s+EXISTS\s+)?'/gi)) {
    const open = match.index + match[0].length - 1
    const offending = vocabularyLiterals(code, open, endOfQuoted(code, open, "'"))
    findings.push(...vocabularyFinding(file, code, 'ADD VALUE', offending))
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
 * [COLUMN], and RENAME COLUMN ... TO. Expects code with strings blanked.
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
    new RegExp(String.raw`\bRENAME\s+COLUMN\s+(?:${IDENTIFIER})\s+TO\s+(${IDENTIFIER})`, 'gi'),
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

/** A migration carries structure, never data: any INSERT or COPY is a seed. UPDATE stays allowed. */
function seedFindings(code: string, file: string): LintFinding[] {
  const findings: LintFinding[] = []
  const statements: [RegExp, string][] = [
    [/\bINSERT\s+INTO\b/gi, 'INSERT'],
    [/(?:^|;)\s*COPY\b/gim, 'COPY'],
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

/** A count such as "93 rows", "10k rows", "1.2M rows", "93 records" or "93 entries". */
const ROW_COUNT = /\b\d[\d.,]*\s*(?:k|m|thousand|million|billion)?\s*(?:rows?|records?|entries|lines)\b/gi

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
      ...closedSetFindings(split.code, file),
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
