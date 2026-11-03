import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  ALLOWED_STRUCTURAL_LITERALS,
  DENIED_COLUMN_WORDS,
  PLACEHOLDER_COMPANY_NAMES,
  REGISTRY_TABLES,
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

function checkFindings(code: string, file: string): LintFinding[] {
  const findings: LintFinding[] = []
  for (const match of code.matchAll(/\bCHECK\s*\(/gi)) {
    const open = match.index + match[0].length - 1
    const close = closingParen(code, open)
    const body = code.slice(open, close + 1)
    const offending: { value: string; index: number }[] = []
    for (const literal of body.matchAll(/'((?:[^']|'')*)'/g)) {
      const value = literal[1] as string
      if (!ALLOWED_STRUCTURAL_LITERALS.includes(value)) {
        offending.push({ value, index: open + literal.index })
      }
    }
    const first = offending[0]
    if (first) {
      findings.push({
        file,
        line: lineOf(code, first.index),
        rule: 'vocabulary-in-check',
        detail: `CHECK lists non-structural literals: ${offending.map((o) => `'${o.value}'`).join(', ')}`,
      })
    }
  }
  return findings
}

function deniedWord(columnName: string): string | undefined {
  const words = columnName.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  return words.find((word) =>
    DENIED_COLUMN_WORDS.includes(word) || DENIED_COLUMN_WORDS.includes(word.replace(/s$/, '')),
  )
}

/** Every column declared by CREATE TABLE or added by ALTER TABLE ... ADD. */
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
  const add = new RegExp(String.raw`\bADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(${IDENTIFIER})`, 'gi')
  for (const match of code.matchAll(add)) {
    const name = match[1] as string
    if (!NON_COLUMN_KEYWORDS.has(name.toLowerCase())) {
      columns.push({ name: unquote(name), index: match.index + match[0].length - name.length })
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

function seedFindings(code: string, file: string): LintFinding[] {
  const findings: LintFinding[] = []
  const insert = new RegExp(String.raw`\bINSERT\s+INTO\s+((?:${IDENTIFIER})(?:\s*\.\s*(?:${IDENTIFIER}))?)`, 'gi')
  for (const match of code.matchAll(insert)) {
    const table = unquote((match[1] as string).split('.').pop()?.trim() ?? '').toLowerCase()
    if (REGISTRY_TABLES.includes(table)) {
      findings.push({
        file,
        line: lineOf(code, match.index),
        rule: 'registry-seed',
        detail: `INSERT into registry table "${table}"; registries ship empty`,
      })
    }
  }
  return findings
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function commentFindings(comments: string, file: string, companyNames: readonly string[]): LintFinding[] {
  const findings: LintFinding[] = []
  comments.split('\n').forEach((text, offset) => {
    const line = offset + 1
    const count = text.match(/\b\d+\s*rows\b/i)
    if (count) {
      findings.push({ file, line, rule: 'leaky-comment', detail: `comment cites a row count: "${count[0]}"` })
    }
    for (const name of companyNames) {
      if (new RegExp(String.raw`\b${escapeRegExp(name)}\b`, 'i').test(text)) {
        findings.push({ file, line, rule: 'leaky-comment', detail: `comment names a company: "${name}"` })
      }
    }
  })
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
    const { code, comments } = splitCodeAndComments(readFileSync(file, 'utf8'))
    return [
      ...checkFindings(code, file),
      ...columnFindings(code, file),
      ...seedFindings(code, file),
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

const formatFinding = (finding: LintFinding): string =>
  `${finding.file}:${finding.line} ${finding.rule} — ${finding.detail}`

if (import.meta.main) {
  const findings = [...lintMigrations('drizzle'), ...lintVanillaPacks('seeds/vanilla')]
  for (const finding of findings) console.log(formatFinding(finding))
  process.exit(findings.length === 0 ? 0 : 1)
}
