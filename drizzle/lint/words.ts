import { DENIED_COLUMN_WORDS, DENIED_SUBSTRINGS } from './forbidden'

/** Words of a name, with camelCase boundaries split before lowercasing. */
export function nameWords(columnName: string): string[] {
  return columnName
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

export function deniedWord(columnName: string): string | undefined {
  const byWord = nameWords(columnName).find((word) =>
    DENIED_COLUMN_WORDS.includes(word) || DENIED_COLUMN_WORDS.includes(word.replace(/s$/, '')),
  )
  return byWord ?? DENIED_SUBSTRINGS.find((fragment) => columnName.toLowerCase().includes(fragment))
}
