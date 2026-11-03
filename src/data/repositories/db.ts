import type { DrizzleClient } from '../client.ts'

/**
 * What every repository function takes as its first argument: the process-wide client,
 * or an open transaction.
 *
 * It is a structural `Pick` rather than a union with the transaction type, for the same
 * reason `Pick<DrizzleClient, 'insert'>` and `Pick<DrizzleClient, 'transaction'>` already
 * appear in `src/data/schema/criteria.ts` and `src/seeds/load-pack.ts`: a transaction
 * exposes the same four verbs with the same signatures, so it satisfies this type without
 * the five type parameters a `PgTransaction<…>` union would spell out, and the compiler
 * states which verbs the repository layer uses. `transaction` is included so a repository
 * can make a multi-statement write atomic; called on a transaction it opens a savepoint,
 * which is what lets one repository compose another.
 */
export type Db = Pick<DrizzleClient, 'select' | 'insert' | 'update' | 'transaction'>
