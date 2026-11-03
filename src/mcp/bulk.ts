import type { Db } from '../data/repositories/db.ts'
import { isItemFault } from '../data/repositories/item-fault.ts'
import { BulkItemError } from '../errors.ts'

/**
 * Runs `perItem` over every item inside ONE transaction, in order, and returns the results in the
 * same order. It is the bulk form of a tool that has no bulk repository function, because what it
 * composes (a score and then a move, say) is the tool's own decision.
 *
 * The first item that fails stops the call and rolls everything before it back, so a half-written
 * batch is never left behind. A fault about the item (`isItemFault`, the same predicate
 * `addPositions` uses) becomes a `BulkItemError` naming the item's index with the real reason as
 * its cause; any other error, such as a lost connection, is rethrown unchanged.
 *
 * `perItem` receives the transaction as its `Db`, so every repository call it makes joins the
 * same transaction. This function only manages that transaction; it touches no table.
 */
export async function inOneTransaction<I, R>(
  db: Db,
  items: readonly I[],
  perItem: (tx: Db, item: I, index: number) => Promise<R>,
): Promise<R[]> {
  return db.transaction(async (tx) => {
    const results: R[] = []
    for (const [index, item] of items.entries()) {
      try {
        results.push(await perItem(tx, item, index))
      } catch (error: unknown) {
        throw isItemFault(error) ? new BulkItemError(index, error) : error
      }
    }
    return results
  })
}
