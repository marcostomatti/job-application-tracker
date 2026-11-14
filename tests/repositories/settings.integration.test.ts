import { describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'

import type { DrizzleClient } from '../../src/data/client.ts'
import { readAppSettings, writeAppSettings } from '../../src/data/repositories/settings.ts'
import { ASK_FLOOR_KEY } from '../../src/data/repositories/stats.ts'
import { POSTING_LINK_PATTERNS_KEY } from '../../src/schemas/posting-links.ts'
import { RECOMMENDATION_DISPLAY_KEY } from '../../src/schemas/recommendation.ts'
import { withMigratedScratchDatabase } from '../data/scratch-database.ts'

type Logged = { readonly context: object; readonly message: string }

function spyLogger(): { readonly logger: { warn(context: object, message: string): void }; readonly logged: Logged[] } {
  const logged: Logged[] = []
  return { logger: { warn: (context, message) => void logged.push({ context, message }) }, logged }
}

async function handEdit(db: DrizzleClient, key: string, jsonLiteral: string): Promise<void> {
  await db.execute(
    sql`insert into app_config (key, value) values (${key}, ${jsonLiteral}::jsonb)
        on conflict (key) do update set value = excluded.value`,
  )
}

describe('readAppSettings', () => {
  test('a fresh install reads the defaults, without logging', async () => {
    const { logger, logged } = spyLogger()

    const settings = await withMigratedScratchDatabase((db) => readAppSettings(db, logger))

    expect(settings).toEqual({ askFloor: 0.5, recommendationDisplay: 'both', postingLinkPatterns: [] })
    expect(logged).toEqual([])
  })

  test('a hand-edited value that is not a display or not a ratio reads as the default, and the display is logged', async () => {
    const { logger, logged } = spyLogger()

    const settings = await withMigratedScratchDatabase(async (db) => {
      await handEdit(db, RECOMMENDATION_DISPLAY_KEY, '"neither"')
      await handEdit(db, ASK_FLOOR_KEY, '7')
      return readAppSettings(db, logger)
    })

    expect(settings).toEqual({ askFloor: 0.5, recommendationDisplay: 'both', postingLinkPatterns: [] })
    expect(logged).toHaveLength(1)
  })

  test('hand-edited link patterns that do not parse read as none, and are logged', async () => {
    const { logger, logged } = spyLogger()

    const settings = await withMigratedScratchDatabase(async (db) => {
      await handEdit(db, POSTING_LINK_PATTERNS_KEY, '[{"prefix": "board", "template": "javascript:alert({id})"}]')
      return readAppSettings(db, logger)
    })

    expect(settings.postingLinkPatterns).toEqual([])
    expect(logged).toHaveLength(1)
  })
})

describe('writeAppSettings', () => {
  test('changes only what the patch names and returns the whole', async () => {
    const { first, second } = await withMigratedScratchDatabase(async (db) => {
      const first = await writeAppSettings(db, { recommendationDisplay: 'agent' })
      const second = await writeAppSettings(db, { askFloor: 0.6 })
      return { first, second }
    })

    expect(first).toEqual({ askFloor: 0.5, recommendationDisplay: 'agent', postingLinkPatterns: [] })
    expect(second).toEqual({ askFloor: 0.6, recommendationDisplay: 'agent', postingLinkPatterns: [] })
  })

  test('stores the link patterns and reads them back, and an empty list clears them', async () => {
    const patterns = [{ prefix: 'board', template: 'https://jobs.example.test/view/{id}/' }]

    const { stored, cleared } = await withMigratedScratchDatabase(async (db) => {
      const stored = await writeAppSettings(db, { postingLinkPatterns: patterns })
      const cleared = await writeAppSettings(db, { postingLinkPatterns: [] })
      return { stored, cleared }
    })

    expect(stored.postingLinkPatterns).toEqual(patterns)
    expect(cleared.postingLinkPatterns).toEqual([])
  })
})
