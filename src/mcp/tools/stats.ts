import type { Db } from '../../data/repositories/db.ts'
import { readAskFloor, readStatsSource, writeAskFloor } from '../../data/repositories/stats.ts'
import { AskFloorInputSchema, MarketStatsQuerySchema, type MarketStatsQuery } from '../../schemas/stats.ts'
import { aggregate } from '../../stats/aggregate.ts'
import { readStats } from '../../stats/reading.ts'
import type { MarketStats } from '../../stats/types.ts'
import { defineTool, type ToolDefinition } from '../register.ts'

/** The stats and their plain-text reading, as both the tool and the HTTP route answer them. */
export async function marketStats(db: Db, args: MarketStatsQuery): Promise<{ stats: MarketStats; reading: string }> {
  const source = await readStatsSource(db, args.criteriaSetId)
  const askFloor = args.askFloor ?? (await readAskFloor(db))
  const stats = aggregate(source.postings, { ...source.context, askFloor, scale: args.scale })
  return { stats, reading: readStats(stats) }
}

/**
 * The market stats group: one read of every aggregate the stats page draws, and the one setting
 * the lead bands take. Kept in a module of its own so it registers apart from the other groups.
 */
export const statsTools: ToolDefinition[] = [
  defineTool({
    name: 'market_stats',
    title: 'Read the market stats',
    description:
      'Aggregates over the postings consumed so far, against ONE criteria set (scores from other sets or versions are never mixed in): ' +
      'lead bands (apply = the stored recommendApply; ask = from the ask floor to below the apply threshold; skip = below the floor or gate-blocked; unscored kept apart), ' +
      'count per score, postings per source split by band, current stage per phase, industry and stack counts (only where a summary records them), ' +
      'average effective coverage per soft requirement with n (null coverage excluded and counted; the lowest is struggling, the highest easiest), ' +
      'seniority, years of experience (summary extra.years_experience only) and common terms. ' +
      'Every count says how many postings were not recorded. Returns { stats, reading }: the JSON and a short text reading. ' +
      'Use it to propose a new chart or insight; nothing is written. scale shows scores and band edges on ratio, stars, percent or basic; coverage stays a ratio.',
    input: MarketStatsQuerySchema,
    annotations: { readOnlyHint: true },
    run: async (args, db) => marketStats(db, args),
  }),
  defineTool({
    name: 'stats_ask_floor_set',
    title: 'Set the ask band floor',
    description:
      'Stores the ratio (0..1) the ask lead band starts at; the default is 0.50 (2.5 stars). Postings below it, or gate-blocked, are skip. ' +
      'Changes how market_stats groups postings and nothing else: no score, posting or stage is touched. Returns { askFloor }.',
    input: AskFloorInputSchema,
    run: async (args, db) => ({ askFloor: await writeAskFloor(db, args.askFloor) }),
  }),
]
