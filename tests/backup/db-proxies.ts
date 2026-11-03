import type { Db } from '../../src/data/repositories/db.ts'

type Select = (...args: unknown[]) => unknown

/** A `Db` whose `select` is wrapped by `around`; every other verb is the real one. */
function wrapSelect(real: Db, around: (select: Select) => Select): Db {
  return new Proxy(real, {
    get(target, property) {
      if (property !== 'select') return Reflect.get(target, property)
      return around((...args) => (target.select as Select)(...args))
    },
  })
}

/** A database that fails its first `failures` selects, as a hiccup at boot or a database that stays down would. */
export function flakyDb(real: Db, failures: number): Db {
  let remaining = failures
  return wrapSelect(real, (select) => (...args) => {
    if (remaining-- > 0) throw new Error('connection reset')
    return select(...args)
  })
}

/** A database that counts its selects, so a test can show it was the one read from. */
export function countingDb(real: Db): { readonly db: Db; selects(): number } {
  let count = 0
  const db = wrapSelect(real, (select) => (...args) => {
    count += 1
    return select(...args)
  })
  return { db, selects: () => count }
}
