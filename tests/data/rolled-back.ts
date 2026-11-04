import { getDb } from '../../src/data/client.ts'

export type Tx = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0]

class Rollback extends Error {}

/**
 * Runs `body` in a transaction that is always rolled back, so a test leaves no
 * rows behind and stays true on a database other tasks have touched. The `token`
 * handed to `body` is unique per call, for names that must not collide.
 */
export async function rolledBack<T>(body: (tx: Tx, token: string) => Promise<T>): Promise<T> {
  let result: T | undefined
  try {
    await getDb().transaction(async (tx) => {
      result = await body(tx, crypto.randomUUID())
      throw new Rollback()
    })
  } catch (error) {
    if (!(error instanceof Rollback)) throw error
  }
  return result as T
}

/**
 * Runs `attempt` and returns what it threw, or undefined when it did not throw.
 * A failed statement aborts the enclosing transaction, so a caller that expects
 * a failure inside `rolledBack` passes a savepoint, not the bare transaction.
 */
export async function thrownBy(attempt: () => Promise<unknown>): Promise<unknown> {
  try {
    await attempt()
  } catch (error) {
    return error
  }
  return undefined
}

/** Runs `run` in a savepoint and returns what it threw. */
export function thrownInSavepoint(tx: Tx, run: (inner: Tx) => Promise<unknown>): Promise<unknown> {
  return thrownBy(() => tx.transaction((inner) => run(inner as Tx)))
}

/**
 * The driver's own message, which names the violated constraint or column. Drizzle wraps
 * the driver error as `cause`; its own message repeats the whole query, which would make
 * every column name match, so only the cause is read.
 */
export function violationText(error: unknown): string {
  const cause = error instanceof Error ? (error.cause as { message?: string } | undefined) : undefined
  return cause?.message ?? ''
}
