import { describe, expect, test } from 'bun:test'
import { count, eq, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import type { DrizzleClient } from '../../src/data/client.ts'
import { addPostings } from '../../src/data/repositories/postings.ts'
import { addRegistryRows, archiveRegistryRow } from '../../src/data/repositories/registries.ts'
import { getBestScores, getScoreHistory, scorePosting } from '../../src/data/repositories/scores.ts'
import { criteriaSet, detour, insertCriteriaSet, requirement } from '../../src/data/schema/criteria.ts'
import { postingStageEvent } from '../../src/data/schema/dispositions.ts'
import { postingPenalty, postingRating, postingRatingDetour, postingScore } from '../../src/data/schema/scores.ts'
import { ArchivedError, ConflictError, NotFoundError, statusFor } from '../../src/errors.ts'
import { requestRescore } from '../../src/data/repositories/rescore.ts'
import { thrownBy, violationText } from '../data/rolled-back.ts'
import { withMigratedScratchDatabase } from '../data/scratch-database.ts'

const ANCHORS = { '0': 'nothing', '0.5': 'some', '1': 'everything' }
const LONG_AGO = '2026-01-01'
const LONGER_AGO = '2025-12-01'

type Arranged = {
  readonly postingId: number
  readonly setId: number
  readonly otherSetId: number
  readonly gate: number
  readonly a: number
  readonly b: number
  readonly other: number
  /** A detour of `a` that gives up half its strength, one of `a` that gives up none, and one of `b`. */
  readonly halfDetour: number
  readonly freeDetour: number
  readonly bDetour: number
}

/** The id at `index`, or a loud failure: an absent row would otherwise read as a pass. */
function idOf(rows: readonly { readonly id: number }[], index = 0): number {
  const id = rows[index]?.id
  if (id === undefined) throw new Error(`the arrangement produced no row at index ${index}`)
  return id
}

/**
 * One posting and two criteria sets. The first set has a threshold of 0.6 and three
 * requirements: a gate with no weight, and two soft ones weighted 3 and 1. The second set has
 * one soft requirement, so a requirement id from it is foreign to the first.
 */
async function arrange(db: DrizzleClient): Promise<Arranged> {
  const [created] = await addPostings(db, [{ company: { name: 'Acme' }, roleTitle: 'Engineer' }])
  if (!created) throw new Error('the arrangement stored no posting')
  const set = await insertCriteriaSet(db, { name: 'Mine', applyThreshold: 0.6 })
  const otherSet = await insertCriteriaSet(db, { name: 'Theirs', applyThreshold: 0.6 })
  const rows = await db
    .insert(requirement)
    .values([
      { criteriaSetId: set.id, key: 'visa', label: 'Visa', kind: 'gate', weight: null, anchors: ANCHORS, sort: 0 },
      { criteriaSetId: set.id, key: 'a', label: 'A', kind: 'soft', weight: 3, anchors: ANCHORS, sort: 1 },
      { criteriaSetId: set.id, key: 'b', label: 'B', kind: 'soft', weight: 1, anchors: ANCHORS, sort: 2 },
      { criteriaSetId: otherSet.id, key: 'other', label: 'Other', kind: 'soft', weight: 1, anchors: ANCHORS },
    ])
    .returning()
  const detours = await db
    .insert(detour)
    .values([
      { requirementId: idOf(rows, 1), label: 'Half way round', discount: 0.5 },
      { requirementId: idOf(rows, 1), label: 'Free way round', discount: 0 },
      { requirementId: idOf(rows, 2), label: 'Way round B', discount: 0.5 },
    ])
    .returning()
  return {
    postingId: created.id,
    setId: set.id,
    otherSetId: otherSet.id,
    gate: idOf(rows, 0),
    a: idOf(rows, 1),
    b: idOf(rows, 2),
    other: idOf(rows, 3),
    halfDetour: idOf(detours, 0),
    freeDetour: idOf(detours, 1),
    bDetour: idOf(detours, 2),
  }
}

type RatingArg = {
  requirementId: number
  coverage: number | null
  confidence: 'supported' | 'partial' | 'unknown'
  evidence?: string | null
  detours?: { detourId: number; coverage: number | null }[]
}

const supported = (requirementId: number, coverage: number | null, evidence?: string): RatingArg => ({
  requirementId,
  coverage,
  confidence: coverage === null ? 'unknown' : 'supported',
  ...(evidence === undefined ? {} : { evidence }),
})

const viaDetours = (rating: RatingArg, ...detours: { detourId: number; coverage: number | null }[]): RatingArg => ({ ...rating, detours })

/** A penalty kind from the registry, which ships empty, so every test makes its own. */
async function aPenaltyKind(db: DrizzleClient, label = 'Relocation'): Promise<number> {
  return idOf(await addRegistryRows(db, 'penalty_kind', [{ label }]))
}

async function countRows(db: DrizzleClient, table: typeof postingScore | typeof postingRating | typeof postingRatingDetour | typeof postingPenalty | typeof postingStageEvent): Promise<number> {
  const [found] = await db.select({ n: count() }).from(table)
  return found?.n ?? 0
}

describe('scorePosting', () => {
  test('stores the overall, floor, ceiling and limiter the function returned', async () => {
    // Arrange / Act
    const { arranged, score, stageEvents } = await withMigratedScratchDatabase(async (db) => {
      const arranged = await arrange(db)
      const score = await scorePosting(db, {
        postingId: arranged.postingId,
        criteriaSetId: arranged.setId,
        ratings: [supported(arranged.gate, 1), supported(arranged.a, 1), supported(arranged.b, 0.5)],
        penalties: [],
      })
      return { arranged, score, stageEvents: await countRows(db, postingStageEvent) }
    })

    // Assert: (3*1 + 1*0.5) / 4, every requirement rated, so the three numbers agree
    expect(score.overall).toBeCloseTo(0.875, 10)
    expect(score.floor).toBeCloseTo(0.875, 10)
    expect(score.ceiling).toBeCloseTo(0.875, 10)
    expect(score).toMatchObject({
      limiterRequirementId: arranged.b,
      limiterKey: 'b',
      limiterCoverage: 0.5,
      limiterIsUnknown: false,
      runnerUpRequirementId: arranged.a,
      runnerUpKey: 'a',
      recommendApply: true,
      isRescore: false,
      note: null,
    })
    expect(stageEvents).toBe(0)
  })

  test('stores a null coverage as not rated, which widens floor and ceiling and names the unrated limiter', async () => {
    // Arrange / Act
    const { arranged, score, stored } = await withMigratedScratchDatabase(async (db) => {
      const arranged = await arrange(db)
      const score = await scorePosting(db, {
        postingId: arranged.postingId,
        criteriaSetId: arranged.setId,
        ratings: [supported(arranged.gate, 1), supported(arranged.a, 1), supported(arranged.b, null)],
        penalties: [],
      })
      const stored = await db.select().from(postingRating).where(eq(postingRating.requirementId, arranged.b))
      return { arranged, score, stored }
    })

    // Assert: overall averages the rated one (a), floor counts b as 0 (3/4), ceiling as 1
    expect(score.overall).toBeCloseTo(1, 10)
    expect(score.floor).toBeCloseTo(0.75, 10)
    expect(score.ceiling).toBeCloseTo(1, 10)
    expect(score).toMatchObject({ limiterRequirementId: arranged.b, limiterCoverage: null, limiterIsUnknown: true })
    expect(stored).toHaveLength(1)
    expect(stored[0]?.coverage).toBeNull()
  })

  test('a set with no weights stores a null overall, floor and ceiling and recommends nothing', async () => {
    // Arrange / Act
    const { score, rows } = await withMigratedScratchDatabase(async (db) => {
      const arranged = await arrange(db)
      await db.update(requirement).set({ weight: null }).where(eq(requirement.criteriaSetId, arranged.setId))
      const score = await scorePosting(db, {
        postingId: arranged.postingId,
        criteriaSetId: arranged.setId,
        ratings: [supported(arranged.gate, 1), supported(arranged.a, 1)],
        penalties: [],
      })
      return { score, rows: await countRows(db, postingScore) }
    })

    // Assert
    expect(score).toMatchObject({ overall: null, floor: null, ceiling: null, recommendApply: false })
    expect(rows).toBe(1)
  })

  test('a set with no requirements stores three nulls and no limiter, and recommends nothing', async () => {
    // Arrange / Act
    const score = await withMigratedScratchDatabase(async (db) => {
      const arranged = await arrange(db)
      const empty = await insertCriteriaSet(db, { name: 'Fresh install', applyThreshold: 0.6 })
      return scorePosting(db, { postingId: arranged.postingId, criteriaSetId: empty.id, ratings: [], penalties: [] })
    })

    // Assert
    expect(score).toMatchObject({
      overall: null,
      floor: null,
      ceiling: null,
      limiterRequirementId: null,
      limiterKey: null,
      limiterCoverage: null,
      limiterIsUnknown: false,
      runnerUpRequirementId: null,
      runnerUpKey: null,
      recommendApply: false,
    })
  })

  test('writes a rating row per requirement given, never a column, with confidence and evidence', async () => {
    // Arrange / Act
    const { arranged, ratings } = await withMigratedScratchDatabase(async (db) => {
      const arranged = await arrange(db)
      await scorePosting(db, {
        postingId: arranged.postingId,
        criteriaSetId: arranged.setId,
        ratings: [
          supported(arranged.gate, 1, 'stated in the posting'),
          { requirementId: arranged.a, coverage: 0.5, confidence: 'partial', evidence: null },
          supported(arranged.b, 0),
        ],
        penalties: [],
      })
      return { arranged, ratings: await db.select().from(postingRating).orderBy(postingRating.requirementId) }
    })

    // Assert: a rated 0 stays 0, and each row carries the set it was scored under
    expect(ratings.map((row) => [row.requirementId, row.coverage, row.confidence, row.evidence])).toEqual([
      [arranged.gate, 1, 'supported', 'stated in the posting'],
      [arranged.a, 0.5, 'partial', null],
      [arranged.b, 0, 'supported', null],
    ])
    expect(new Set(ratings.map((row) => row.criteriaSetId))).toEqual(new Set([arranged.setId]))
  })

  test('stores each penalty with its kind and takes it off the score', async () => {
    // Arrange / Act
    const { score, penalties, kindId } = await withMigratedScratchDatabase(async (db) => {
      const arranged = await arrange(db)
      const kindId = await aPenaltyKind(db)
      const score = await scorePosting(db, {
        postingId: arranged.postingId,
        criteriaSetId: arranged.setId,
        ratings: [supported(arranged.gate, 1), supported(arranged.a, 1), supported(arranged.b, 0.5)],
        penalties: [{ penaltyKindId: kindId, amount: -0.25, reason: 'moving is required' }],
        note: 'a note',
      })
      return { score, kindId, penalties: await db.select().from(postingPenalty) }
    })

    // Assert
    expect(score.overall).toBeCloseTo(0.625, 10)
    expect(score.note).toBe('a note')
    expect(penalties).toHaveLength(1)
    expect(penalties[0]).toMatchObject({ penaltyKindId: kindId, amount: -0.25, reason: 'moving is required' })
  })

  test('refuses a penalty naming an archived kind, and one that does not exist, writing nothing', async () => {
    // Arrange / Act
    const { archivedError, missingError, scores, penalties } = await withMigratedScratchDatabase(async (db) => {
      const arranged = await arrange(db)
      const kindId = await aPenaltyKind(db)
      await archiveRegistryRow(db, 'penalty_kind', kindId)
      const base = { postingId: arranged.postingId, criteriaSetId: arranged.setId, ratings: [supported(arranged.a, 1)] }
      return {
        archivedError: await thrownBy(() => scorePosting(db, { ...base, penalties: [{ penaltyKindId: kindId, amount: -0.1 }] })),
        missingError: await thrownBy(() => scorePosting(db, { ...base, penalties: [{ penaltyKindId: 9999, amount: -0.1 }] })),
        scores: await countRows(db, postingScore),
        penalties: await countRows(db, postingPenalty),
      }
    })

    // Assert
    expect(archivedError).toBeInstanceOf(ArchivedError)
    expect(missingError).toBeInstanceOf(NotFoundError)
    expect(scores).toBe(0)
    expect(penalties).toBe(0)
  })

  test('a second score the same day for the same set replaces that day\'s row, its ratings and its penalties', async () => {
    // Arrange / Act
    const { arranged, first, second, scores, ratings, penalties } = await withMigratedScratchDatabase(async (db) => {
      const arranged = await arrange(db)
      const kindId = await aPenaltyKind(db)
      const base = { postingId: arranged.postingId, criteriaSetId: arranged.setId }
      const first = await scorePosting(db, {
        ...base,
        ratings: [supported(arranged.gate, 1), supported(arranged.a, 0), supported(arranged.b, 0)],
        penalties: [{ penaltyKindId: kindId, amount: -0.5 }],
        note: 'first pass',
      })
      const second = await scorePosting(db, {
        ...base,
        ratings: [supported(arranged.gate, 1), supported(arranged.a, 1)],
        penalties: [],
      })
      return {
        arranged,
        first,
        second,
        scores: await db.select().from(postingScore),
        ratings: await db.select().from(postingRating).orderBy(postingRating.requirementId),
        penalties: await countRows(db, postingPenalty),
      }
    })

    // Assert: one row, the same one, now describing the second call only
    expect(scores).toHaveLength(1)
    expect(second.id).toBe(first.id)
    expect(second).toMatchObject({ overall: 1, isRescore: false, note: null, limiterKey: 'b', limiterIsUnknown: true })
    expect(ratings.map((row) => [row.requirementId, row.coverage])).toEqual([
      [arranged.gate, 1],
      [arranged.a, 1],
    ])
    expect(penalties).toBe(0)
  })

  test('a score on a later day is a new row marked isRescore, and a repeat that day updates it', async () => {
    // Arrange / Act
    const { arranged, scores } = await withMigratedScratchDatabase(async (db) => {
      const arranged = await arrange(db)
      const input = { postingId: arranged.postingId, criteriaSetId: arranged.setId, penalties: [] }
      await scorePosting(db, { ...input, ratings: [supported(arranged.a, 0)] })
      await db.update(postingScore).set({ scoredAt: LONG_AGO })
      await scorePosting(db, { ...input, ratings: [supported(arranged.a, 1)] })
      await scorePosting(db, { ...input, ratings: [supported(arranged.a, 0.5)] })
      return { arranged, scores: await db.select().from(postingScore).orderBy(postingScore.scoredAt) }
    })

    // Assert
    expect(scores.map((row) => [row.isRescore, row.overall])).toEqual([
      [false, 0],
      [true, 0.5],
    ])
    expect(scores[0]?.scoredAt).toBe(LONG_AGO)
    expect(String(scores[1]?.scoredAt) > LONG_AGO).toBe(true)
    expect(scores.map((row) => row.criteriaSetId)).toEqual([arranged.setId, arranged.setId])
  })

  test('scores the same posting against another set the same day as a new row that is not a rescore', async () => {
    // Arrange / Act
    const scores = await withMigratedScratchDatabase(async (db) => {
      const arranged = await arrange(db)
      await scorePosting(db, { postingId: arranged.postingId, criteriaSetId: arranged.setId, ratings: [supported(arranged.a, 1)], penalties: [] })
      await scorePosting(db, { postingId: arranged.postingId, criteriaSetId: arranged.otherSetId, ratings: [supported(arranged.other, 1)], penalties: [] })
      return db.select().from(postingScore)
    })

    // Assert
    expect(scores).toHaveLength(2)
    expect(scores.map((row) => row.isRescore)).toEqual([false, false])
  })

  test('refuses a rating naming a requirement from another set as a ConflictError with no SQL, rolling the score back', async () => {
    // Arrange / Act
    const { error, scores, ratings } = await withMigratedScratchDatabase(async (db) => {
      const arranged = await arrange(db)
      const error = await thrownBy(() =>
        scorePosting(db, {
          postingId: arranged.postingId,
          criteriaSetId: arranged.setId,
          ratings: [supported(arranged.a, 1), supported(arranged.other, 1)],
          penalties: [],
        }),
      )
      return { error, scores: await countRows(db, postingScore), ratings: await countRows(db, postingRating) }
    })

    // Assert: the composite foreign key is still the guarantee; the fault is typed on its way out
    expect(error).toBeInstanceOf(ConflictError)
    expect(statusFor(error)).toBe(409)
    expect(error).toMatchObject({ field: 'criteria set' })
    expect((error as Error).message).not.toMatch(/insert|select|posting_rating|violates|\$\d/i)
    expect(violationText((error as Error).cause)).toContain('posting_rating_set_requirement_fk')
    expect(scores).toBe(0)
    expect(ratings).toBe(0)
  })

  test('refuses a posting or a criteria set that does not exist', async () => {
    // Arrange / Act
    const { missingPosting, missingSet } = await withMigratedScratchDatabase(async (db) => {
      const arranged = await arrange(db)
      return {
        missingPosting: await thrownBy(() => scorePosting(db, { postingId: 9999, criteriaSetId: arranged.setId, ratings: [], penalties: [] })),
        missingSet: await thrownBy(() => scorePosting(db, { postingId: arranged.postingId, criteriaSetId: 9999, ratings: [], penalties: [] })),
      }
    })

    // Assert
    expect(missingPosting).toBeInstanceOf(NotFoundError)
    expect(missingSet).toBeInstanceOf(NotFoundError)
  })

  test('a detour lifts a requirement above its direct rating by its coverage times what it keeps', async () => {
    // Arrange / Act
    const { direct, lifted } = await withMigratedScratchDatabase(async (db) => {
      const arranged = await arrange(db)
      const base = { postingId: arranged.postingId, criteriaSetId: arranged.setId, penalties: [] }
      const direct = await scorePosting(db, { ...base, ratings: [supported(arranged.a, 0.2)] })
      const lifted = await scorePosting(db, {
        ...base,
        ratings: [viaDetours(supported(arranged.a, 0.2), { detourId: arranged.halfDetour, coverage: 1 })],
      })
      return { direct, lifted }
    })

    // Assert: 1 x (1 - 0.5) = 0.5 beats the direct 0.2, and the stored overall says so
    expect(direct.overall).toBeCloseTo(0.2, 10)
    expect(lifted.overall).toBeCloseTo(0.5, 10)
  })

  test('a requirement with no direct rating counts as rated once a detour with coverage is given', async () => {
    // Arrange / Act
    const { unrated, byDetour, stored } = await withMigratedScratchDatabase(async (db) => {
      const arranged = await arrange(db)
      const base = { postingId: arranged.postingId, criteriaSetId: arranged.setId, penalties: [] }
      const unrated = await scorePosting(db, { ...base, ratings: [supported(arranged.a, null), supported(arranged.b, 1)] })
      const byDetour = await scorePosting(db, {
        ...base,
        ratings: [viaDetours(supported(arranged.a, null), { detourId: arranged.halfDetour, coverage: 0.8 }), supported(arranged.b, 1)],
      })
      return { unrated, byDetour, stored: await db.select().from(postingRating).where(eq(postingRating.requirementId, arranged.a)) }
    })

    // Assert: with a unrated, overall is b alone (1); with a detour, a counts as 0.8 x 0.5 = 0.4,
    // so overall is (3 x 0.4 + 1 x 1) / 4 and the floor and ceiling meet
    expect(unrated.overall).toBeCloseTo(1, 10)
    expect(unrated.floor).toBeCloseTo(0.25, 10)
    expect(byDetour.overall).toBeCloseTo(0.55, 10)
    expect(byDetour.floor).toBeCloseTo(0.55, 10)
    expect(byDetour.ceiling).toBeCloseTo(0.55, 10)
    expect(stored[0]?.coverage).toBeNull()
  })

  test('a detour with a discount of 0 contributes its full coverage', async () => {
    // Arrange / Act
    const score = await withMigratedScratchDatabase(async (db) => {
      const arranged = await arrange(db)
      return scorePosting(db, {
        postingId: arranged.postingId,
        criteriaSetId: arranged.setId,
        ratings: [viaDetours(supported(arranged.a, 0.2), { detourId: arranged.freeDetour, coverage: 0.9 })],
        penalties: [],
      })
    })

    // Assert
    expect(score.overall).toBeCloseTo(0.9, 10)
  })

  test('a detour with a null coverage, or none given, leaves the score as the direct rating made it', async () => {
    // Arrange / Act
    const { direct, nullCoverage } = await withMigratedScratchDatabase(async (db) => {
      const arranged = await arrange(db)
      const base = { postingId: arranged.postingId, criteriaSetId: arranged.setId, penalties: [] }
      const direct = await scorePosting(db, { ...base, ratings: [supported(arranged.a, 0.2)] })
      const nullCoverage = await scorePosting(db, {
        ...base,
        ratings: [viaDetours(supported(arranged.a, 0.2), { detourId: arranged.halfDetour, coverage: null })],
      })
      return { direct, nullCoverage }
    })

    // Assert
    expect(nullCoverage.overall).toBe(direct.overall)
    expect(nullCoverage.limiterCoverage).toBe(direct.limiterCoverage)
  })

  test('stores each detour coverage under its rating, null as not rated, and replaces them with the ratings', async () => {
    // Arrange / Act
    const { arranged, afterFirst, afterSecond } = await withMigratedScratchDatabase(async (db) => {
      const arranged = await arrange(db)
      const base = { postingId: arranged.postingId, criteriaSetId: arranged.setId, penalties: [] }
      await scorePosting(db, {
        ...base,
        ratings: [
          viaDetours(
            supported(arranged.a, null),
            { detourId: arranged.halfDetour, coverage: 0.4 },
            { detourId: arranged.freeDetour, coverage: null },
          ),
        ],
      })
      const afterFirst = await db.select().from(postingRatingDetour).orderBy(postingRatingDetour.detourId)
      await scorePosting(db, { ...base, ratings: [viaDetours(supported(arranged.a, 1), { detourId: arranged.halfDetour, coverage: 0 })] })
      return { arranged, afterFirst, afterSecond: await db.select().from(postingRatingDetour) }
    })

    // Assert: a same-day re-score leaves exactly the second call's detour coverages
    expect(afterFirst.map((row) => [row.requirementId, row.detourId, row.coverage])).toEqual([
      [arranged.a, arranged.halfDetour, 0.4],
      [arranged.a, arranged.freeDetour, null],
    ])
    expect(afterSecond.map((row) => [row.detourId, row.coverage])).toEqual([[arranged.halfDetour, 0]])
  })

  test('refuses a detour coverage naming a detour of another requirement, as a ConflictError, writing nothing', async () => {
    // Arrange / Act
    const { error, scores, stored, direct, bDetourId } = await withMigratedScratchDatabase(async (db) => {
      const arranged = await arrange(db)
      const error = await thrownBy(() =>
        scorePosting(db, {
          postingId: arranged.postingId,
          criteriaSetId: arranged.setId,
          ratings: [viaDetours(supported(arranged.a, 0.2), { detourId: arranged.bDetour, coverage: 1 })],
          penalties: [],
        }),
      )
      // The same pair written straight to the table is refused by the same constraint
      const scoreId = idOf(await db.insert(postingScore).values({ postingId: arranged.postingId, criteriaSetId: arranged.setId }).returning())
      await db.insert(postingRating).values({ scoreId, criteriaSetId: arranged.setId, requirementId: arranged.a })
      const direct = await thrownBy(() =>
        db.insert(postingRatingDetour).values({ scoreId, requirementId: arranged.a, detourId: arranged.bDetour, coverage: 1 }),
      )
      return { error, scores: await countRows(db, postingScore), stored: await countRows(db, postingRatingDetour), direct, bDetourId: arranged.bDetour }
    })

    // Assert
    expect(error).toBeInstanceOf(ConflictError)
    expect(statusFor(error)).toBe(409)
    expect((error as Error).message).not.toMatch(/insert|select|posting_rating|violates|\$\d/i)
    expect(error).toMatchObject({ field: 'requirement detour' })
    expect((error as ConflictError).key).toBe(String(bDetourId))
    expect((error as Error).message).toContain('not a detour of the requirement')
    expect(violationText((error as Error).cause)).toContain('posting_rating_detour_detour_fk')
    expect(violationText(direct)).toContain('posting_rating_detour_detour_fk')
    expect(scores).toBe(1)
    expect(stored).toBe(0)
  })

  test('two connections scoring the same day at once leave one row whose ratings are one call\'s, whole', async () => {
    // Arrange / Act
    const { scores, ratings, arranged } = await withMigratedScratchDatabase(async (db, sql) => {
      const url = new URL(process.env.DATABASE_URL ?? '')
      url.pathname = `/${sql.options.database}`
      const second = postgres(url.toString(), { max: 1, onnotice: () => {} })
      try {
        const arranged = await arrange(db)
        const input = { postingId: arranged.postingId, criteriaSetId: arranged.setId, penalties: [] }
        await Promise.all([
          scorePosting(db, { ...input, ratings: [supported(arranged.a, 0), supported(arranged.b, 0)] }),
          scorePosting(drizzle(second), { ...input, ratings: [supported(arranged.a, 1), supported(arranged.b, 1)] }),
        ])
        return { arranged, scores: await db.select().from(postingScore), ratings: await db.select().from(postingRating) }
      } finally {
        await second.end()
      }
    })

    // Assert: the row's overall and its ratings come from the same call, whichever committed last
    expect(scores).toHaveLength(1)
    expect(ratings).toHaveLength(2)
    const coverages = new Set(ratings.map((row) => row.coverage))
    expect(coverages.size).toBe(1)
    expect(scores[0]?.overall).toBe([...coverages][0] as number)
    expect(new Set(ratings.map((row) => row.requirementId))).toEqual(new Set([arranged.a, arranged.b]))
  })
})

describe('a criteria set that has been archived', () => {
  const archive = (db: DrizzleClient, setId: number): Promise<unknown> =>
    db.update(criteriaSet).set({ archivedAt: new Date() }).where(eq(criteriaSet.id, setId))

  test('is refused by scorePosting and requestRescore, with nothing written', async () => {
    // Arrange / Act
    const { scoreError, requestError, scores, pending } = await withMigratedScratchDatabase(async (db) => {
      const arranged = await arrange(db)
      await archive(db, arranged.setId)
      return {
        scoreError: await thrownBy(() =>
          scorePosting(db, { postingId: arranged.postingId, criteriaSetId: arranged.setId, ratings: [supported(arranged.a, 1)], penalties: [] }),
        ),
        requestError: await thrownBy(() => requestRescore(db, { criteriaSetId: arranged.setId, sinceDate: '2026-01-01' })),
        scores: await countRows(db, postingScore),
        pending: await db.execute(sql`select count(*)::int as n from rescore_request`),
      }
    })

    // Assert
    expect(scoreError).toBeInstanceOf(ArchivedError)
    expect(requestError).toBeInstanceOf(ArchivedError)
    expect(scoreError).toMatchObject({ entity: 'criteria set' })
    expect((scoreError as Error).message).toBe(`criteria set ${(scoreError as ArchivedError).id} is archived`)
    expect(statusFor(scoreError)).toBe(409)
    expect(scores).toBe(0)
    expect(pending[0]?.n).toBe(0)
  })

  test('still has its earlier scores read back, by history and by best score', async () => {
    // Arrange / Act
    const { arranged, history, best } = await withMigratedScratchDatabase(async (db) => {
      const arranged = await arrange(db)
      await scorePosting(db, { postingId: arranged.postingId, criteriaSetId: arranged.setId, ratings: [supported(arranged.a, 1)], penalties: [] })
      await archive(db, arranged.setId)
      return { arranged, history: await getScoreHistory(db, arranged.postingId), best: await getBestScores(db, arranged.postingId) }
    })

    // Assert
    expect(history.map((row) => row.criteriaSetId)).toEqual([arranged.setId])
    expect(best.map((row) => row.criteriaSetId)).toEqual([arranged.setId])
  })
})

describe('getBestScores across versions of one set name', () => {
  /** Inserts a bare score row, which is all the version rule reads. */
  async function insertScore(db: DrizzleClient, postingId: number, criteriaSetId: number, overall: number, scoredAt: string): Promise<void> {
    await db.insert(postingScore).values({ postingId, criteriaSetId, overall, scoredAt, recommendApply: overall >= 0.5 })
  }

  async function arrangeVersions(db: DrizzleClient): Promise<{ postingId: number; v1: number; v2: number; other: number }> {
    const [created] = await addPostings(db, [{ company: { name: 'Acme' }, roleTitle: 'Engineer' }])
    if (!created) throw new Error('the arrangement stored no posting')
    const v1 = await insertCriteriaSet(db, { name: 'web-search', version: 1, applyThreshold: 0.5 })
    const v2 = await insertCriteriaSet(db, { name: 'web-search', version: 2, applyThreshold: 0.5 })
    const other = await insertCriteriaSet(db, { name: 'perspective-b', version: 1, applyThreshold: 0.5 })
    return { postingId: created.id, v1: v1.id, v2: v2.id, other: other.id }
  }

  test('a posting scored under v1 and v2 of one name has one best score, and it is v2\'s', async () => {
    // Arrange / Act
    const { arranged, best, history } = await withMigratedScratchDatabase(async (db) => {
      const arranged = await arrangeVersions(db)
      await insertScore(db, arranged.postingId, arranged.v1, 0.9, LONGER_AGO)
      await insertScore(db, arranged.postingId, arranged.v2, 0.2, LONG_AGO)
      return { arranged, best: await getBestScores(db, arranged.postingId), history: await getScoreHistory(db, arranged.postingId) }
    })

    // Assert: history keeps both, best keeps the non-superseded one
    expect(history).toHaveLength(2)
    expect(best).toHaveLength(1)
    expect(best[0]).toMatchObject({ criteriaSetId: arranged.v2, criteriaSetName: 'web-search', criteriaSetVersion: 2, overall: 0.2 })
  })

  test('a name whose newest version has not scored the posting yields no row for the older version', async () => {
    // Arrange / Act
    const best = await withMigratedScratchDatabase(async (db) => {
      const arranged = await arrangeVersions(db)
      await insertScore(db, arranged.postingId, arranged.v1, 0.9, LONG_AGO)
      return getBestScores(db, arranged.postingId)
    })

    // Assert: the old version is superseded as soon as the new one exists, scored or not
    expect(best).toEqual([])
  })

  test('different set names are separate lenses, each keeping its own latest score', async () => {
    // Arrange / Act
    const { arranged, best } = await withMigratedScratchDatabase(async (db) => {
      const arranged = await arrangeVersions(db)
      await insertScore(db, arranged.postingId, arranged.v2, 0.7, LONG_AGO)
      await insertScore(db, arranged.postingId, arranged.v2, 0.8, '2026-02-01')
      await insertScore(db, arranged.postingId, arranged.other, 0.3, LONG_AGO)
      return { arranged, best: await getBestScores(db, arranged.postingId) }
    })

    // Assert: newest first, one row per name, the latest day within a name
    expect(best.map((row) => [row.criteriaSetName, row.criteriaSetVersion, row.criteriaSetId, row.overall])).toEqual([
      ['web-search', 2, arranged.v2, 0.8],
      ['perspective-b', 1, arranged.other, 0.3],
    ])
  })

  test('scorePosting and the history carry the set name and version too', async () => {
    // Arrange / Act
    const { arranged, scored, history } = await withMigratedScratchDatabase(async (db) => {
      const arranged = await arrange(db)
      const scored = await scorePosting(db, { postingId: arranged.postingId, criteriaSetId: arranged.setId, ratings: [supported(arranged.a, 1)], penalties: [] })
      return { arranged, scored, history: await getScoreHistory(db, arranged.postingId) }
    })

    // Assert
    expect(scored).toMatchObject({ criteriaSetId: arranged.setId, criteriaSetName: 'Mine', criteriaSetVersion: 1 })
    expect(history[0]).toMatchObject({ criteriaSetName: 'Mine', criteriaSetVersion: 1 })
  })
})

describe('getScoreHistory and getBestScores', () => {
  /** Two scores against the first set on different days, and one against the second set. */
  async function scored(db: DrizzleClient): Promise<Arranged> {
    const arranged = await arrange(db)
    const input = { postingId: arranged.postingId, penalties: [] }
    await scorePosting(db, { ...input, criteriaSetId: arranged.setId, ratings: [supported(arranged.a, 0)] })
    await db.update(postingScore).set({ scoredAt: LONGER_AGO })
    await scorePosting(db, { ...input, criteriaSetId: arranged.setId, ratings: [supported(arranged.a, 0.5)] })
    await db.update(postingScore).set({ scoredAt: LONG_AGO }).where(eq(postingScore.overall, 0.5))
    await scorePosting(db, { ...input, criteriaSetId: arranged.otherSetId, ratings: [supported(arranged.other, 1)] })
    return arranged
  }

  test('history is newest first and every row names its set and limiter key', async () => {
    // Arrange / Act
    const { arranged, history } = await withMigratedScratchDatabase(async (db) => {
      const arranged = await scored(db)
      return { arranged, history: await getScoreHistory(db, arranged.postingId) }
    })

    // Assert: today's score against the other set, then the two older ones
    expect(history.map((row) => [row.criteriaSetId, row.overall])).toEqual([
      [arranged.otherSetId, 1],
      [arranged.setId, 0.5],
      [arranged.setId, 0],
    ])
    // a requirement nobody rated ties at 0 with a rated zero, and the rated zero is named first
    expect(history.map((row) => row.limiterKey)).toEqual(['other', 'b', 'a'])
  })

  test('best scores are the latest score per set, newest first', async () => {
    // Arrange / Act
    const { arranged, best } = await withMigratedScratchDatabase(async (db) => {
      const arranged = await scored(db)
      return { arranged, best: await getBestScores(db, arranged.postingId) }
    })

    // Assert
    expect(best.map((row) => [row.criteriaSetId, row.overall])).toEqual([
      [arranged.otherSetId, 1],
      [arranged.setId, 0.5],
    ])
  })

  test('a posting never scored has no history, and one that does not exist is refused', async () => {
    // Arrange / Act
    const { history, best, missing } = await withMigratedScratchDatabase(async (db) => {
      const arranged = await arrange(db)
      return {
        history: await getScoreHistory(db, arranged.postingId),
        best: await getBestScores(db, arranged.postingId),
        missing: await thrownBy(() => getScoreHistory(db, 9999)),
      }
    })

    // Assert
    expect(history).toEqual([])
    expect(best).toEqual([])
    expect(missing).toBeInstanceOf(NotFoundError)
  })
})
