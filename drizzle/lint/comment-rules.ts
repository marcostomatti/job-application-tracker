import type { LintFinding } from './types'
import { deniedProseWord } from './words'

export type CommentRun = { text: string; lineAt: number[] }

/**
 * Normalise comments for matching: strip the comment markers and leading
 * stars, collapse whitespace, and join consecutive comment lines into one
 * text, so a count or a name wrapped across lines still reads as one phrase.
 * `lineAt[i]` is the source line of character `i` of the text.
 */
export function commentRuns(comments: string): CommentRun[] {
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

export const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * A count such as "93 rows", "10k rows", "1.2M rows", "93 records" or "93
 * entries": the number and the noun are adjacent. A "3." list marker is not a
 * number here, because a number's decimal point must be followed by digits.
 */
export const ROW_COUNT = /(?<![\w.])\d+(?:[.,]\d+)*\s*(?:k|m|thousand|million|billion)?\s*(?:rows?|records?|entries)\b/gi

export function commentFindings(comments: string, file: string, companyNames: readonly string[]): LintFinding[] {
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
    for (const token of run.text.matchAll(/[\p{L}\p{N}_]+/gu)) {
      const word = deniedProseWord(token[0])
      if (word) {
        findings.push({
          file,
          line: run.lineAt[token.index] as number,
          rule: 'leaky-comment',
          detail: `comment uses "${word}"; a comment must not carry vocabulary or opinion`,
        })
      }
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
