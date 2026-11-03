/**
 * Reading SQL text: separating comments from code, blanking strings, and the
 * small scanners (balanced parens, statement ends) the rules share. Nothing
 * here knows what a rule is. Every function keeps offsets and line breaks
 * identical between its input and output, so a match index maps to one line.
 */

export type SplitSql = {
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
export const DOLLAR_TAG = String.raw`\$(?:[A-Za-z_\u0080-\uFFFF][A-Za-z0-9_\u0080-\uFFFF]*)?\$`
const IDENTIFIER_CHAR = /[A-Za-z0-9_$\u0080-\uFFFF]/
export const DOLLAR_TAG_AT_START = new RegExp(`^${DOLLAR_TAG}`)
export const COMMENT_ON_OPENER = new RegExp(String.raw`\bCOMMENT\s+ON\s+[^;'$]*?\bIS\s+[eE]?('|${DOLLAR_TAG})`, 'gi')
/**
 * A string literal: an `E'...'` string (where a backslash escapes the next
 * character), a plain `'...'` string (where only a doubled quote does), or a
 * dollar-quoted string. Groups: 1 the E string's text, 2 the plain text, 3 the
 * dollar tag, 4 the dollar-quoted text.
 */
export const LITERAL = new RegExp(
  String.raw`(?<![\w$])[eE]'((?:[^'\\]|\\[\s\S]|'')*)'|'((?:[^']|'')*)'|(${DOLLAR_TAG})([\s\S]*?)\3`,
  'g',
)

export const IDENTIFIER = String.raw`"[^"]+"|\w+`

export const lineOf = (text: string, index: number): number =>
  text.slice(0, index).split('\n').length

export const blank = (char: string): string => (char === '\n' ? '\n' : ' ')

/** An error naming what was left open and where, so a run that read nothing past it cannot pass. */
function unterminated(what: string, sql: string, index: number): Error {
  const hint =
    what === 'string'
      ? " (write E'...' if it uses a backslash escape such as \\', because in a plain '...' string only a doubled quote escapes a quote)"
      : ''
  return new Error(`unterminated ${what} on line ${lineOf(sql, index)}${hint}`)
}

/**
 * Separate comments from code in one pass, keeping offsets and line breaks
 * identical in both outputs so a match index maps to the same line in each.
 * Throws when a block comment, string, quoted identifier or dollar quote is
 * never closed: everything after it would otherwise be read as part of it,
 * and a whole file would be reported clean.
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
      if (end === -1) throw unterminated('block comment', sql, i)
      const stop = end + 2
      const block = sql.slice(i, stop)
      comments += block
      code += [...block].map(blank).join('')
      i = stop
    } else if (char === "'" || char === '"' || tag) {
      const stop = tag ? endOfLiteral(sql, i) : endOfQuoted(sql, i, char)
      const closed = tag ? sql.indexOf(tag, i + tag.length) !== -1 : scanQuoted(sql, i, char).closed
      if (!closed) throw unterminated(tag ? 'dollar-quoted string' : char === '"' ? 'quoted identifier' : 'string', sql, i)
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

/** Whether the quote at `start` opens an `E'...'` string, inside which a backslash escapes the next character. */
function opensEscapeString(text: string, start: number): boolean {
  return /[eE]/.test(text[start - 1] ?? '') && !IDENTIFIER_CHAR.test(text[start - 2] ?? '')
}

/**
 * Where a quoted run ends and whether its closing quote was found. A doubled
 * quote is an escaped quote; inside an `E'...'` string so is `\'`.
 */
export function scanQuoted(text: string, start: number, quote: string): { end: number; closed: boolean } {
  const backslashEscapes = quote === "'" && opensEscapeString(text, start)
  let i = start + 1
  while (i < text.length) {
    if (backslashEscapes && text[i] === '\\') {
      i += 2
    } else if (text[i] === quote) {
      if (text[i + 1] === quote) i += 2
      else return { end: i + 1, closed: true }
    } else i += 1
  }
  return { end: text.length, closed: false }
}

/** Index just past the closing quote (or the end of the text when there is none). */
export function endOfQuoted(text: string, start: number, quote: string): number {
  return scanQuoted(text, start, quote).end
}

/** The `$tag$` that opens a dollar-quoted string at `index`, if one does. */
export function dollarTagAt(text: string, index: number): string | undefined {
  if (text[index] !== '$') return undefined
  // A `$` after an identifier character is part of that identifier (`a$b$c`), not a quote.
  if (IDENTIFIER_CHAR.test(text[index - 1] ?? '')) return undefined
  return DOLLAR_TAG_AT_START.exec(text.slice(index, index + 64))?.[0]
}

/** Index just past the string literal opened at `open`: single-quoted or dollar-quoted. */
export function endOfLiteral(text: string, open: number): number {
  if (/[eE]/.test(text[open] ?? '') && text[open + 1] === "'") return endOfQuoted(text, open + 1, "'")
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
export function blankStrings(code: string): string {
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
export function withCommentOnText(code: string, comments: string): string {
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
export function closingParen(text: string, open: number): number {
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
export function topLevelItems(text: string, from: number, to: number): { start: number; text: string }[] {
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

export const unquote = (identifier: string): string => identifier.replace(/^"|"$/g, '')

/** Index of the next top-level `;`, skipping quoted text, or the end of the text. */
export function endOfStatement(text: string, from: number): number {
  let i = from
  while (i < text.length) {
    const char = text[i] as string
    if (char === "'" || char === '"') i = endOfQuoted(text, i, char)
    else if (char === ';') return i
    else i += 1
  }
  return text.length
}
