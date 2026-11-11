import { isApplied } from '../../data/repositories/dispositions.ts'
import {
  attachOrigin,
  getFirstTouch,
  listOrigins,
  recordOrigin,
  recordSearchRun,
  routeCounts,
  wasReposted,
} from '../../data/repositories/provenance.ts'
import { summaryChanged } from '../../data/repositories/summaries.ts'
import { EmptyInputSchema } from '../../schemas/common.ts'
import { PostingRefSchema } from '../../schemas/postings.ts'
import {
  OriginAttachInputSchema,
  OriginBulkSchema,
  OriginInputSchema,
  SearchRunInputSchema,
} from '../../schemas/provenance.ts'
import { PostingChangedQuerySchema } from '../../schemas/summaries.ts'
import { inOneTransaction } from '../bulk.ts'
import { defineTool, type ToolDefinition } from '../register.ts'

/**
 * §11.1 groups 8 and 9: how leads reached the user, the machine searches that found some, and
 * the three yes/no checks made before acting on a posting. Each check is one repository
 * function that lives next to the data it reads; none is restated here.
 */
export const provenanceTools: ToolDefinition[] = [
  defineTool({
    name: 'origin_record',
    title: 'Record how a lead arrived',
    description:
      'Logs ONE touch, a dated way a lead reached the user, and returns it as stored. A job board hit, a message and a conversation at a meetup all have this shape. ' +
      'touchedOn (YYYY-MM-DD) is required and may be backdated: it is when the person was reached, which is what decides the first touch, not when it was logged. ' +
      'postingId is optional because a conversation may come before any posting exists (tie it later with origin_attach); routeId is optional because the route list may be empty; searchRunId is for a touch a machine search found (see search_run_record). ' +
      'An archived route is refused and an unknown posting, route or search run is a not-found error. Use origin_record_bulk for several.',
    input: OriginInputSchema,
    run: async (args, db) => recordOrigin(db, args),
  }),
  defineTool({
    name: 'origin_record_bulk',
    title: 'Record several origins',
    description:
      'Logs up to 500 touches in one call, each as origin_record takes it, and returns them as stored, in the order given. ' +
      'All or none: if any item fails (an unknown posting, an archived route), nothing is logged and the error names the failing item by its index. ' +
      'Prefer this to repeated origin_record calls when importing a history of how leads arrived.',
    input: OriginBulkSchema,
    run: async (args, db) => inOneTransaction(db, args.items, (tx, item) => recordOrigin(tx, item)),
  }),
  defineTool({
    name: 'origin_attach',
    title: 'Attach a touch to a posting',
    description:
      'Ties an existing touch that has no posting yet to ONE posting, and returns the touch. Use it when a conversation was logged before the posting existed. ' +
      'Only the posting changes: the touch keeps its own date and route, so attaching a backdated conversation can make it the posting\'s first touch. ' +
      'Repeating the call for the same posting changes nothing. A touch already on another posting is a conflict, and an unknown touch or posting is a not-found error.',
    input: OriginAttachInputSchema,
    run: async (args, db) => attachOrigin(db, args.originId, args.postingId),
  }),
  defineTool({
    name: 'origin_list',
    title: 'List the origins of a posting',
    description:
      'Lists every touch recorded on ONE posting, earliest first (by touchedOn, then when it was logged), including future-dated ones. ' +
      'An unknown posting id is a not-found error, and a posting with no touch returns an empty list. ' +
      'Use origin_first_touch for only the one that first reached the posting, and route_counts to compare routes across postings.',
    input: PostingRefSchema,
    run: async (args, db) => listOrigins(db, args.postingId),
  }),
  defineTool({
    name: 'origin_first_touch',
    title: 'Get the first touch of a posting',
    description:
      'Returns the touch that FIRST reached ONE posting, or null when it has none dated today or earlier. ' +
      'It is worked out from the dates the touches carry, so a conversation logged afterwards but dated earlier beats a job-board hit logged first. ' +
      'An unknown posting id is a not-found error. Use origin_list for every touch on the posting.',
    input: PostingRefSchema,
    run: async (args, db) => getFirstTouch(db, args.postingId),
  }),
  defineTool({
    name: 'route_counts',
    title: 'Count postings by route',
    description:
      'Returns how many postings each route reached, busiest first: [{ routeId, routeLabel, postings }]. ' +
      'A posting counts once under each route it came through, so the rows do not add up to the number of postings; touches with no route make one row with a null route, and touches with no posting are left out. ' +
      'The label is there even for a route archived since. Use this to see which routes bring leads; use origin_list for the touches of one posting. Takes no arguments.',
    input: EmptyInputSchema,
    run: async (_args, db) => routeCounts(db),
  }),
  defineTool({
    name: 'search_run_record',
    title: 'Record a search run',
    description:
      'Records ONE machine search, what was asked (query) and where (source), and returns it with its id and the time it ran. ' +
      'params optionally keeps the search parameters as any JSON value (filters, keywords, a radius), so searches can be compared later by what they asked for; null or left out means none. ' +
      'A run says nothing about postings by itself: pass its id as searchRunId to origin_record for each touch it found, so the query that found a lead can be traced.',
    input: SearchRunInputSchema,
    run: async (args, db) => recordSearchRun(db, args),
  }),
  defineTool({
    name: 'check_already_applied',
    title: 'Check whether a posting was applied to',
    description:
      'Answers true or false: has the user ALREADY APPLIED to ONE posting? True only when its latest stage is one the user flagged as applied; ' +
      'false when it has no stage event, an event with no stage, or a stage that is not flagged. ' +
      'Run this before drafting or sending an application. It asks nothing about the posting text (that is check_posting_changed) or about the role coming round again (that is check_reposted). ' +
      'An unknown posting id is a not-found error.',
    input: PostingRefSchema,
    run: async (args, db) => isApplied(db, args.postingId),
  }),
  defineTool({
    name: 'check_posting_changed',
    title: 'Check whether a posting changed',
    description:
      'Answers true or false: has the POSTING TEXT of ONE posting changed since its summary was written? ' +
      'Give sourceHash, the hash of the posting as it reads now; true means it differs from the hash stored with the summary, or that no summary is stored yet, so a summary is due either way. ' +
      'Run this before re-summarising, to skip a posting that has not changed. It does not say whether the user applied (that is check_already_applied) or whether the role was posted again (that is check_reposted). ' +
      'An unknown posting id is a not-found error.',
    input: PostingChangedQuerySchema,
    run: async (args, db) => summaryChanged(db, args.postingId, args.sourceHash),
  }),
  defineTool({
    name: 'check_reposted',
    title: 'Check whether a role was reposted',
    description:
      'Answers true or false: did ONE posting COME ROUND AGAIN, that is, does it have more than one touch recorded, by any route and on any date? ' +
      'Run this when a role looks familiar, to tell a repost from a first sighting. It does not compare posting text (that is check_posting_changed) or look at the user\'s stage (that is check_already_applied). ' +
      'Use origin_list to see the touches themselves. An unknown posting id is a not-found error.',
    input: PostingRefSchema,
    run: async (args, db) => wasReposted(db, args.postingId),
  }),
]
