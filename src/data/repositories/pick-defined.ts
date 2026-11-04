/**
 * The listed keys of `source` whose value is present; absent keys are left out, not nulled.
 * A write built from it names its columns in one list, so an object that carries more than
 * the type says (a TypeScript type does not stop an extra property on a variable) cannot
 * write a column the list does not name.
 */
export function pickDefined<T extends object, K extends keyof T>(source: T, keys: readonly K[]): Partial<Pick<T, K>> {
  const present = keys.flatMap((key) => (source[key] === undefined ? [] : [[key, source[key]] as const]))
  return Object.fromEntries(present) as Partial<Pick<T, K>>
}
