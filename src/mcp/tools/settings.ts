import { readAppSettings, writeAppSettings } from '../../data/repositories/settings.ts'
import { EmptyInputSchema } from '../../schemas/common.ts'
import { AppSettingsPatchSchema } from '../../schemas/recommendation.ts'
import { defineTool, type ToolDefinition } from '../register.ts'

/**
 * The app settings the web Settings page edits: the ask floor (the same value
 * `stats_ask_floor_set` writes), which recommendation the app shows, and the posting link
 * patterns. A group of its own, so the Settings page and an agent read and write them through
 * the same two tools.
 */
export const settingsTools: ToolDefinition[] = [
  defineTool({
    name: 'settings_get',
    title: 'Get the app settings',
    description:
      'Returns the app settings as { askFloor, recommendationDisplay, postingLinkPatterns }. askFloor is the ratio (0..1) the ask band starts at, the one market_stats and the rules recommendation read (default 0.50). ' +
      'recommendationDisplay is which recommendation the board, grid and detail show: rules (computed from the score), agent (your stored verdict) or both (the default). ' +
      'postingLinkPatterns turns posting keys into links in the posting panel: a key "<prefix>:<id>" opens that prefix\'s template with {id} filled in (default none). Takes no arguments.',
    input: EmptyInputSchema,
    annotations: { readOnlyHint: true },
    run: async (_args, db) => readAppSettings(db),
  }),
  defineTool({
    name: 'settings_update',
    title: 'Change the app settings',
    description:
      'Changes the settings you name, { askFloor?, recommendationDisplay?, postingLinkPatterns? }, at least one, and returns the whole settings as stored. ' +
      'askFloor is a ratio 0..1; recommendationDisplay is rules, agent or both. postingLinkPatterns REPLACES the whole list: [{ prefix, template }], ' +
      'where prefix is one word and template an http(s) address holding {id}, e.g. { prefix: "board", template: "https://jobs.example.test/view/{id}" }; [] clears it. ' +
      'A setting you leave out keeps its value. No score, posting or stage is touched.',
    input: AppSettingsPatchSchema,
    run: async (args, db) => writeAppSettings(db, args),
  }),
]
