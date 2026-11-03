import { addPositions, getPosition, searchPositions, updatePosition } from '../../data/repositories/positions.ts'
import {
  PositionBulkSchema,
  PositionInputSchema,
  PositionQuerySchema,
  PositionRefSchema,
  PositionUpdateBulkSchema,
  PositionUpdateInputSchema,
} from '../../schemas/positions.ts'
import { defineTool, type ToolDefinition } from '../register.ts'
import { inOneTransaction } from '../bulk.ts'
import { unwrapSingleItem } from '../result.ts'

/** §11.1 group 1: recording, reading, searching and editing positions. */
export const positionTools: ToolDefinition[] = [
  defineTool({
    name: 'position_add',
    title: 'Add a position',
    description:
      'Records ONE position (a role at an employer) and returns it as stored, with its new id. ' +
      'The employer is given by name, so no lookup is needed first and two spellings of one employer reach one company. ' +
      'Use this for a single capture; use position_add_bulk to record several at once. ' +
      'Fails if the same role at the same employer already exists, or if a referenced work format, seniority or apply route does not exist or is archived. ' +
      'It never sets priorityRank, which only position_update can.',
    input: PositionInputSchema,
    run: async (args, db) => {
      try {
        const [created] = await addPositions(db, [args])
        if (!created) throw new Error('The position insert returned no row.')
        return created
      } catch (error: unknown) {
        throw unwrapSingleItem(error)
      }
    },
  }),
  defineTool({
    name: 'position_add_bulk',
    title: 'Add several positions',
    description:
      'Records up to 500 positions in one call and returns them as stored, in the order given, with their ids. ' +
      'All or none: if any item fails, nothing is written and the error names the failing item by its index. ' +
      'Prefer this to repeated position_add calls when pasting or importing a list.',
    input: PositionBulkSchema,
    run: async (args, db) => addPositions(db, args.items),
  }),
  defineTool({
    name: 'position_get',
    title: 'Get one position in full',
    description:
      'Returns everything known about ONE position, by id: the position, its company, the registry rows it references, its summary, ' +
      'its latest stage, every score with its ratings and penalties, its set-aside or rejection records and where it was found. ' +
      'Use this for the detail view of a position whose id you already have; to find positions by company, phase or recommendation, use position_search, which returns one lighter row each. ' +
      'An unknown id is a not-found error.',
    input: PositionRefSchema,
    run: async (args, db) => getPosition(db, args.positionId),
  }),
  defineTool({
    name: 'position_search',
    title: 'Search positions',
    description:
      'Searches positions for the board and the grid, filtered by company, phase, recommend-apply and by whether set-aside or client-hidden positions are shown; ' +
      'returns one row per position (the position, its company, its current stage and phase, its latest score under one criteria set, and a set-aside flag), newest seen first, in pages. ' +
      'Set-aside and client-hidden positions are left out unless the filters say include or only. ' +
      'Use this to find or list positions; use position_get when you already have an id and want the full detail.',
    input: PositionQuerySchema,
    run: async (args, db) => searchPositions(db, args),
  }),
  defineTool({
    name: 'position_update',
    title: 'Update a position',
    description:
      'Changes the named fields of ONE position and returns it as stored; fields left out are kept, and a nullable field set to null is cleared. ' +
      'This is the only tool that can set priorityRank, the user\'s own hand-ranking. The employer cannot be changed: a role moved to another employer is a different position. ' +
      'An empty patch is refused, an unknown id is a not-found error, and a title that now collides with another position at the same employer is a conflict.',
    input: PositionUpdateInputSchema,
    run: async (args, db) => updatePosition(db, args.positionId, args.patch),
  }),
  defineTool({
    name: 'position_update_bulk',
    title: 'Update several positions',
    description:
      'Applies a patch to each of up to 500 positions in one call, each item being { positionId, patch }, and returns the positions as stored, in the order given. ' +
      'All or none: if any item fails (an unknown id, an archived reference, a title collision), nothing is changed and the error names the failing item by its index. ' +
      'Prefer this to repeated position_update calls when changing many positions; each patch follows the same rules as position_update, including that an empty patch is refused.',
    input: PositionUpdateBulkSchema,
    run: async (args, db) =>
      inOneTransaction(db, args.items, (tx, item) => updatePosition(tx, item.positionId, item.patch)),
  }),
]
