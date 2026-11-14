import { eq, sql } from 'drizzle-orm'

import { lazyLogger } from '../../logging.ts'
import { POSTING_LINK_PATTERNS_KEY, PostingLinkPatternsSchema, type PostingLinkPattern } from '../../schemas/posting-links.ts'
import {
  DEFAULT_RECOMMENDATION_DISPLAY,
  RECOMMENDATION_DISPLAY_KEY,
  RecommendationDisplaySchema,
  type AppSettings,
  type AppSettingsPatch,
  type RecommendationDisplay,
} from '../../schemas/recommendation.ts'
import { appConfig } from '../schema/config.ts'
import type { FallbackLog } from './config.ts'
import type { Db } from './db.ts'
import { readAskFloor, writeAskFloor } from './stats.ts'

/** The module's own logger, made on first use so importing this file starts no logger. */
const defaultLogger = lazyLogger('app-settings')

/**
 * Which recommendation the app shows. The value is untrusted jsonb a person may edit by hand,
 * so anything but a known display falls back to the default and is logged; an absent key is a
 * fresh install and is not.
 */
async function readRecommendationDisplay(db: Db, logger: FallbackLog): Promise<RecommendationDisplay> {
  const [row] = await db.select({ value: appConfig.value }).from(appConfig).where(eq(appConfig.key, RECOMMENDATION_DISPLAY_KEY))
  if (!row) return DEFAULT_RECOMMENDATION_DISPLAY
  const parsed = RecommendationDisplaySchema.safeParse(row.value)
  if (parsed.success) return parsed.data
  logger.warn({ key: RECOMMENDATION_DISPLAY_KEY }, 'unrecognised recommendation display in app_config; using the default')
  return DEFAULT_RECOMMENDATION_DISPLAY
}

async function writeRecommendationDisplay(db: Db, display: RecommendationDisplay): Promise<void> {
  await db
    .insert(appConfig)
    .values({ key: RECOMMENDATION_DISPLAY_KEY, value: display })
    .onConflictDoUpdate({ target: appConfig.key, set: { value: display, updatedAt: sql`now()` } })
}

/**
 * How posting keys become links. Like the display, the value is jsonb a person may edit by hand,
 * so a list that does not parse reads as none and is logged; an absent key is none, unlogged.
 */
async function readPostingLinkPatterns(db: Db, logger: FallbackLog): Promise<PostingLinkPattern[]> {
  const [row] = await db.select({ value: appConfig.value }).from(appConfig).where(eq(appConfig.key, POSTING_LINK_PATTERNS_KEY))
  if (!row) return []
  const parsed = PostingLinkPatternsSchema.safeParse(row.value)
  if (parsed.success) return parsed.data
  logger.warn({ key: POSTING_LINK_PATTERNS_KEY }, 'unusable posting link patterns in app_config; showing no pattern links')
  return []
}

async function writePostingLinkPatterns(db: Db, patterns: readonly PostingLinkPattern[]): Promise<void> {
  await db
    .insert(appConfig)
    .values({ key: POSTING_LINK_PATTERNS_KEY, value: patterns })
    .onConflictDoUpdate({ target: appConfig.key, set: { value: patterns, updatedAt: sql`now()` } })
}

/**
 * The settings the web Settings page shows. Each is read from its own `app_config` key, the ask
 * floor from the one `market_stats` already reads, so the two pages can never disagree about it.
 * A stored value that cannot be used reads as that setting's default.
 */
export async function readAppSettings(db: Db, logger: FallbackLog = defaultLogger()): Promise<AppSettings> {
  const [askFloor, recommendationDisplay, postingLinkPatterns] = await Promise.all([
    readAskFloor(db),
    readRecommendationDisplay(db, logger),
    readPostingLinkPatterns(db, logger),
  ])
  return { askFloor, recommendationDisplay, postingLinkPatterns }
}

/**
 * Stores the settings a patch names, leaves the rest as stored, and returns the whole as it now
 * reads. Every write runs in one transaction, so a patch naming several never stores part of itself.
 */
export async function writeAppSettings(db: Db, patch: AppSettingsPatch, logger: FallbackLog = defaultLogger()): Promise<AppSettings> {
  return db.transaction(async (tx) => {
    if (patch.askFloor !== undefined) await writeAskFloor(tx, patch.askFloor)
    if (patch.recommendationDisplay !== undefined) await writeRecommendationDisplay(tx, patch.recommendationDisplay)
    if (patch.postingLinkPatterns !== undefined) await writePostingLinkPatterns(tx, patch.postingLinkPatterns)
    return readAppSettings(tx, logger)
  })
}
