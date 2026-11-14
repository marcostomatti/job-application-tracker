import { findPostingKey } from '../../data/repositories/posting-key.ts'
import type { Db } from '../../data/repositories/db.ts'
import type { NotebookClient } from '../../notebook/client.ts'
import { postingText } from '../../notebook/posting-text.ts'
import { PostingRefSchema } from '../../schemas/postings.ts'
import { webRoute, type RouteSpec } from './spec.ts'

/**
 * The web panel's read of a posting's full text, from the notebook copy titled with its posting
 * key. It is built at startup with the notebook client, or with none when no notebook is
 * configured, so the route always exists and answers `configured: false` then. An unknown
 * posting is a not-found error; a notebook that does not answer is a 503.
 */
export function postingTextRoutes(
  client: NotebookClient | undefined,
  keyOf: (db: Db, postingId: number) => Promise<string> = findPostingKey,
): readonly RouteSpec[] {
  return [
    webRoute('get', '/postings/:postingId/notebook-text', PostingRefSchema, async (args, db) =>
      postingText(client, await keyOf(db, args.postingId)),
    ),
  ]
}
