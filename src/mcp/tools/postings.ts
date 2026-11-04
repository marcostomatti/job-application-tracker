import { addPostings, getPosting, searchPostings, updatePosting } from '../../data/repositories/postings.ts'
import {
  PostingBulkSchema,
  PostingInputSchema,
  PostingQuerySchema,
  PostingRefSchema,
  PostingUpdateBulkSchema,
  PostingUpdateInputSchema,
} from '../../schemas/postings.ts'
import { defineTool, type ToolDefinition } from '../register.ts'
import { inOneTransaction } from '../bulk.ts'
import { unwrapSingleItem } from '../result.ts'

/** §11.1 group 1: recording, reading, searching and editing postings. */
export const postingTools: ToolDefinition[] = [
  defineTool({
    name: 'posting_add',
    title: 'Add a posting',
    description:
      'Records ONE posting (a role at an employer) and returns it as stored, with its new id. ' +
      'The employer is given by name, so no lookup is needed first and two spellings of one employer reach one company. ' +
      'Use this for a single capture; use posting_add_bulk to record several at once. ' +
      'Fails if the same role at the same employer already exists, or if a referenced work format, seniority or apply route does not exist or is archived. ' +
      'It never sets priorityRank, which only posting_update can.',
    input: PostingInputSchema,
    run: async (args, db) => {
      try {
        const [created] = await addPostings(db, [args])
        if (!created) throw new Error('The posting insert returned no row.')
        return created
      } catch (error: unknown) {
        throw unwrapSingleItem(error)
      }
    },
  }),
  defineTool({
    name: 'posting_add_bulk',
    title: 'Add several postings',
    description:
      'Records up to 500 postings in one call and returns them as stored, in the order given, with their ids. ' +
      'All or none: if any item fails, nothing is written and the error names the failing item by its index. ' +
      'Prefer this to repeated posting_add calls when pasting or importing a list.',
    input: PostingBulkSchema,
    run: async (args, db) => addPostings(db, args.items),
  }),
  defineTool({
    name: 'posting_get',
    title: 'Get one posting in full',
    description:
      'Returns everything known about ONE posting, by id: the posting, its company, the registry rows it references, its summary, ' +
      'its latest stage, every score with its ratings and penalties, its set-aside or rejection records and where it was found. ' +
      'Use this for the detail view of a posting whose id you already have; to find postings by company, phase or recommendation, use posting_search, which returns one lighter row each. ' +
      'An unknown id is a not-found error.',
    input: PostingRefSchema,
    run: async (args, db) => getPosting(db, args.postingId),
  }),
  defineTool({
    name: 'posting_search',
    title: 'Search postings',
    description:
      'Searches postings for the board and the grid, filtered by company, phase, recommend-apply and by whether set-aside or client-hidden postings are shown; ' +
      'returns one row per posting (the posting, its company, its current stage and phase, its latest score under one criteria set, and a set-aside flag), newest seen first, in pages. ' +
      'Set-aside and client-hidden postings are left out unless the filters say include or only. ' +
      'Use this to find or list postings; use posting_get when you already have an id and want the full detail.',
    input: PostingQuerySchema,
    run: async (args, db) => searchPostings(db, args),
  }),
  defineTool({
    name: 'posting_update',
    title: 'Update a posting',
    description:
      'Changes the named fields of ONE posting and returns it as stored; fields left out are kept, and a nullable field set to null is cleared. ' +
      'This is the only tool that can set priorityRank, the user\'s own hand-ranking. The employer cannot be changed: a role moved to another employer is a different posting. ' +
      'An empty patch is refused, an unknown id is a not-found error, and a title that now collides with another posting at the same employer is a conflict.',
    input: PostingUpdateInputSchema,
    run: async (args, db) => updatePosting(db, args.postingId, args.patch),
  }),
  defineTool({
    name: 'posting_update_bulk',
    title: 'Update several postings',
    description:
      'Applies a patch to each of up to 500 postings in one call, each item being { postingId, patch }, and returns the postings as stored, in the order given. ' +
      'All or none: if any item fails (an unknown id, an archived reference, a title collision), nothing is changed and the error names the failing item by its index. ' +
      'Prefer this to repeated posting_update calls when changing many postings; each patch follows the same rules as posting_update, including that an empty patch is refused.',
    input: PostingUpdateBulkSchema,
    run: async (args, db) =>
      inOneTransaction(db, args.items, (tx, item) => updatePosting(tx, item.postingId, item.patch)),
  }),
]
