import {
  appendStageEvent,
  currentStage,
  listSetAside,
  recordRejection,
  setAside,
} from '../../data/repositories/dispositions.ts'
import { EmptyInputSchema } from '../../schemas/common.ts'
import {
  RecordRejectionInputSchema,
  SetAsideInputSchema,
  StageEventBulkSchema,
  StageEventInputSchema,
} from '../../schemas/dispositions.ts'
import { PostingRefSchema } from '../../schemas/postings.ts'
import { inOneTransaction } from '../bulk.ts'
import { defineTool, type ToolDefinition } from '../register.ts'

/**
 * §11.1 group 7: where a posting stands, and why the user passed on one. There is deliberately
 * no tool that edits or removes a stage event: the history is append-only, a correction is a
 * later event, and the tests pin that no tool name here says otherwise.
 */
export const dispositionTools: ToolDefinition[] = [
  defineTool({
    name: 'stage_current',
    title: 'Get the current stage of a posting',
    description:
      'Returns where ONE posting stands now: { event, stage }, its latest stage event (by the time it occurred) and the stage it names with that stage\'s flags. ' +
      'Returns null when the posting has no event yet, and also when its latest event names no stage, which is normal before any stages have been set up. ' +
      'An unknown posting id is a not-found error. This is the stage only; use posting_get for everything about a posting, or check_already_applied for a yes/no on whether it was applied to.',
    input: PostingRefSchema,
    run: async (args, db) => currentStage(db, args.postingId),
  }),
  defineTool({
    name: 'stage_append',
    title: 'Record a stage event',
    description:
      'Records ONE move of ONE posting into a stage and returns the event. History is append-only: an event is never edited or removed, ' +
      'and a correction is a later event, so recording a stage again adds a second event and the latest one counts as current. ' +
      'stageId is required but may be null, for an event with no stage (the stage registry may be empty). ' +
      'occurredAt is an ISO-8601 time WITH its offset, such as 2026-06-01T10:00:00Z, and is the moment the event is dated when left out; give it to backdate. ' +
      'An archived stage is refused and an unknown posting or stage is a not-found error. Use stage_append_bulk for several, and stage_current to read the result.',
    input: StageEventInputSchema,
    run: async (args, db) => appendStageEvent(db, args),
  }),
  defineTool({
    name: 'stage_append_bulk',
    title: 'Record several stage events',
    description:
      'Records up to 500 stage events in one call, each as stage_append takes it, and returns them as stored, in the order given. ' +
      'All or none: if any item fails (an unknown posting, an archived stage), nothing is recorded and the error names the failing item by its index. ' +
      'Prefer this to repeated stage_append calls when moving many postings at once.',
    input: StageEventBulkSchema,
    run: async (args, db) => inOneTransaction(db, args.items, (tx, item) => appendStageEvent(tx, item)),
  }),
  defineTool({
    name: 'posting_set_aside',
    title: 'Set a posting aside',
    description:
      'Records that the user passed on ONE posting, for a reason from the set-aside reasons, and returns the record. ' +
      'The reason is required, because the reasons are what the user\'s criteria are refined from. A note is optional. ' +
      'The posting\'s stage is not changed: setting aside and moving through stages are separate. ' +
      'An archived reason is refused and an unknown posting or reason is a not-found error. ' +
      'Use posting_reject instead when the other side turned the user down; use set_aside_list to read what was set aside, grouped by reason.',
    input: SetAsideInputSchema,
    run: async (args, db) => setAside(db, args),
  }),
  defineTool({
    name: 'posting_reject',
    title: 'Record a rejection',
    description:
      'Records that the other side turned ONE posting down, for a reason from the rejection reasons, and returns the record. ' +
      'These reasons are a different list from the set-aside reasons and the two are not interchangeable. A note is optional. ' +
      'The posting\'s stage is not changed. An archived reason is refused and an unknown posting or reason is a not-found error. ' +
      'Use posting_set_aside instead when the user chose to pass.',
    input: RecordRejectionInputSchema,
    run: async (args, db) => recordRejection(db, args),
  }),
  defineTool({
    name: 'set_aside_list',
    title: 'List set-aside postings by reason',
    description:
      'Returns every set-aside posting grouped by the reason it was last set aside for: [{ reasonId, reasonLabel, postings }], in reason order, each posting as posting_search shows it. ' +
      'The label is there even for a reason archived since. Use this to see why the user passes on leads, so a gate or a weight can be refined or the user asked about a pattern. ' +
      'A posting that was only rejected is not listed, and a later rejection does not remove a posting from its group. Takes no arguments, and the result is complete, never truncated or paged: an empty list means nothing was set aside.',
    input: EmptyInputSchema,
    run: async (_args, db) => listSetAside(db),
  }),
]
