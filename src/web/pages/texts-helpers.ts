import type { TextAsset, TextTypeRow } from '../data.ts'

/** How much of a body the collapsed row shows before the ellipsis. */
export const BODY_PREVIEW_LENGTH = 90

/** The type filter's value for "every type". */
export const ALL_TYPES = 'all'

/** The type filter's value for texts with no type yet (the text type registry ships empty). */
export const NO_TYPE = 'none'

/**
 * One text as the page lists it: the label that groups its versions, the newest version, and
 * every version newest first. Without history the list holds the newest alone.
 */
export interface TextGroup {
  readonly label: string
  readonly newest: TextAsset
  readonly versions: readonly TextAsset[]
}

export interface TextFilter {
  /** Free text, matched case-insensitively against the label and every version's body. */
  readonly query: string
  /** `ALL_TYPES`, `NO_TYPE`, or a text type id as a string (a select's value). */
  readonly type: string
}

/** The body on one line, cut at `BODY_PREVIEW_LENGTH` with an ellipsis. */
export function preview(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim()
  return flat.length <= BODY_PREVIEW_LENGTH ? flat : `${flat.slice(0, BODY_PREVIEW_LENGTH)}…`
}

const byVersionDesc = (a: TextAsset, b: TextAsset): number => b.version - a.version

/**
 * Groups rows by label, in label order, each group's versions newest first. The server already
 * sorts this way; sorting again keeps the page right if that order ever changes.
 */
export function groupTexts(texts: readonly TextAsset[]): TextGroup[] {
  const byLabel = new Map<string, TextAsset[]>()
  for (const text of texts) {
    byLabel.set(text.label, [...(byLabel.get(text.label) ?? []), text])
  }
  return [...byLabel.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([label, rows]) => {
      const versions = [...rows].sort(byVersionDesc)
      const [newest] = versions
      return newest === undefined ? [] : [{ label, newest, versions }]
    })
}

/** The select value a text's type maps to. */
export function typeValue(textTypeId: number | null): string {
  return textTypeId === null ? NO_TYPE : String(textTypeId)
}

/** Text type labels by id, from the registry read; an empty map when that read failed. */
export type TypeNames = ReadonlyMap<number, string>

const NO_NAMES: TypeNames = new Map()

/** The registry rows as a lookup from id to label. */
export function typeNamesOf(rows: readonly Pick<TextTypeRow, 'id' | 'label'>[]): TypeNames {
  return new Map(rows.map((row) => [row.id, row.label]))
}

/**
 * How a type is printed: its registry label, or "Type N" when the id is not in `names` (the
 * registry read failed, or the type was archived and so is not listed). A text with none says so.
 */
export function typeName(textTypeId: number | null, names: TypeNames = NO_NAMES): string {
  if (textTypeId === null) return 'Untyped'
  return names.get(textTypeId) ?? `Type ${textTypeId}`
}

/** The distinct types of the newest versions, by printed name, untyped last, as select options. */
export function typeOptions(groups: readonly TextGroup[], names: TypeNames = NO_NAMES): { value: string; label: string }[] {
  const ids = [...new Set(groups.map((group) => group.newest.textTypeId))]
  const typed = ids
    .filter((id): id is number => id !== null)
    .map((id) => ({ value: typeValue(id), label: typeName(id, names) }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }))
  return ids.includes(null) ? [...typed, { value: NO_TYPE, label: typeName(null) }] : typed
}

/** The groups that pass the type filter (judged on the newest version) and the search. */
export function filterTexts(groups: readonly TextGroup[], filter: TextFilter): TextGroup[] {
  const needle = filter.query.trim().toLowerCase()
  return groups.filter((group) => {
    if (filter.type !== ALL_TYPES && typeValue(group.newest.textTypeId) !== filter.type) return false
    if (needle === '') return true
    if (group.label.toLowerCase().includes(needle)) return true
    return group.versions.some((version) => version.body.toLowerCase().includes(needle))
  })
}

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })

/** A stored timestamp as a date; the JSON route sends a string, a direct caller a Date. */
export function formatDate(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : dateFormat.format(date)
}
