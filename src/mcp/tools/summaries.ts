import { getSummary, writeSummary } from '../../data/repositories/summaries.ts'
import { PositionRefSchema } from '../../schemas/positions.ts'
import { SummaryInputSchema } from '../../schemas/summaries.ts'
import { defineTool, type ToolDefinition } from '../register.ts'

/** §11.1 group 2: the condensed, regenerable summary of a posting. */
export const summaryTools: ToolDefinition[] = [
  defineTool({
    name: 'summary_write',
    title: 'Write a position summary',
    description:
      'Writes the summary of ONE position, replacing any earlier one in full, and returns it as stored. ' +
      'A summary is regenerated from the posting each time, so a field you leave out is cleared and not kept. ' +
      'sourceHash identifies the posting text the summary came from, so a later repost can be told from an unchanged one. ' +
      'An unknown position is a not-found error. Use summary_get to read a summary back.',
    input: SummaryInputSchema,
    run: async (args, db) => writeSummary(db, args),
  }),
  defineTool({
    name: 'summary_get',
    title: 'Get a position summary',
    description:
      'Returns the stored summary of ONE position, or null when the position exists and has not been summarised yet. ' +
      'An unknown position id is a not-found error, which is how "nothing written yet" is told from "no such position". ' +
      'The summary alone is cheaper than position_get, which returns it among everything else.',
    input: PositionRefSchema,
    run: async (args, db) => getSummary(db, args.positionId),
  }),
]
