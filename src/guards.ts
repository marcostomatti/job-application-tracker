/** A plain object: not `null`, not an array. What a JSON body or a stored jsonb value must be for its fields to be read. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
