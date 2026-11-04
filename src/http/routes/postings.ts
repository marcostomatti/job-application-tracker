import { updatePosting } from '../../data/repositories/postings.ts'
import { listOrigins } from '../../data/repositories/provenance.ts'
import { getSummary } from '../../data/repositories/summaries.ts'
import { findPostings, readPosting } from '../../mcp/tools/postings.ts'
import {
  PostingGetQuerySchema,
  PostingQuerySchema,
  PostingRefSchema,
  PostingUpdateInputSchema,
} from '../../schemas/postings.ts'
import { route, type RouteSpec } from './spec.ts'

/** The routes that read and edit postings, and what is stored about one: its summary and its origins. */
export const postingRoutes: readonly RouteSpec[] = [
  route('get', '/postings', 'posting_search', PostingQuerySchema, async (args, db) => findPostings(db, args)),
  route('get', '/postings/:postingId', 'posting_get', PostingGetQuerySchema, async (args, db) =>
    readPosting(db, args),
  ),
  route('patch', '/postings/:postingId', 'posting_update', PostingUpdateInputSchema, async (args, db) =>
    updatePosting(db, args.postingId, args.patch),
  ),
  route('get', '/postings/:postingId/summary', 'summary_get', PostingRefSchema, async (args, db) =>
    getSummary(db, args.postingId),
  ),
  route('get', '/postings/:postingId/origins', 'origin_list', PostingRefSchema, async (args, db) =>
    listOrigins(db, args.postingId),
  ),
]
