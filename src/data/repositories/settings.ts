import { eq, sql } from 'drizzle-orm'

import { lazyLogger } from '../../logging.ts'
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
 * The settings the web Settings page shows. Each is read from its own `app_config` key, the ask
 * floor from the one `market_stats` already reads, so the two pages can never disagree about it.
 * A stored value that cannot be used reads as that setting's default.
 */
export async function readAppSettings(db: Db, logger: FallbackLog = defaultLogger()): Promise<AppSettings> {
  const [askFloor, recommendationDisplay] = await Promise.all([readAskFloor(db), readRecommendationDisplay(db, logger)])
  return { askFloor, recommendationDisplay }
}

/**
 * Stores the settings a patch names, leaves the rest as stored, and returns the whole as it now
 * reads. Both writes run in one transaction, so a patch naming both never stores half of itself.
 */
export async function writeAppSettings(db: Db, patch: AppSettingsPatch, logger: FallbackLog = defaultLogger()): Promise<AppSettings> {
  return db.transaction(async (tx) => {
    if (patch.askFloor !== undefined) await writeAskFloor(tx, patch.askFloor)
    if (patch.recommendationDisplay !== undefined) await writeRecommendationDisplay(tx, patch.recommendationDisplay)
    return readAppSettings(tx, logger)
  })
}
