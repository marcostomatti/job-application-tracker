import { DENIED_COLUMN_WORDS, DENIED_SUBSTRINGS, PROSE_WORDS } from './forbidden'

/** Words of a name, with camelCase boundaries split before lowercasing. */
export function nameWords(columnName: string): string[] {
  return columnName
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

const isDeniedWord = (word: string): boolean =>
  DENIED_COLUMN_WORDS.includes(word) || DENIED_COLUMN_WORDS.includes(word.replace(/s$/, ''))

/**
 * For an identifier: whole words (after camelCase splitting) and, for the long
 * specific words, anywhere inside the name, because `penaltyfintech` has no
 * boundary to split on.
 */
export function deniedWord(columnName: string): string | undefined {
  const byWord = nameWords(columnName).find(isDeniedWord)
  return byWord ?? DENIED_SUBSTRINGS.find((fragment) => columnName.toLowerCase().includes(fragment))
}

/**
 * For a word of prose in a comment: whole words only, never inside another
 * word, and the lower-case spelling of an ordinary English word (`PROSE_WORDS`)
 * is allowed. Prose has word boundaries, so the substring list is not used.
 */
export function deniedProseWord(token: string): string | undefined {
  if (token === token.toLowerCase() && PROSE_WORDS.includes(token.replace(/s$/, ''))) return undefined
  return nameWords(token).find(isDeniedWord)
}
