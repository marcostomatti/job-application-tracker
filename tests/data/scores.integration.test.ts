import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { eq, sql } from 'drizzle-orm'

import { lintMigrations } from '../../drizzle/lint/migration-lint'
import { closeDb } from '../../src/data/client.ts'
import { criteriaSet, detour, requirement } from '../../src/data/schema/criteria.ts'
import { penaltyKind } from '../../src/data/schema/registries.ts'
import { company, posting } from '../../src/data/schema/postings.ts'
import { postingPenalty, postingRating, postingScore } from '../../src/data/schema/scores.ts'
import { DetourSchema, PenaltySchema, RatingSchema } from '../../src/schemas/scoring.ts'
import { rolledBack, thrownInSavepoint, violationText, type Tx } from './rolled-back.ts'

const MIGRATIONS_DIR = join(import.meta.dir, '..', '..', 'drizzle')
const ANCHORS = { '0': 'does not meet it', '0.5': 'partly meets it', '1': 'fully meets it' }

afterAll(async () => {
  await closeDb()
})

/** A company, a posting and a criteria set with one requirement, all unique to this call. */
async function seed(tx: Tx, token: string, setVersion = 1) {
  const [owner] = await tx
    .insert(company)
    .values({ name: `test-co-${token}`, nameNorm: `test-co-${token}` })
    .returning()
  const [role] = await tx
    .insert(posting)
    .values({
      postingKey: `test-posting-${token}`,
      companyId: owner?.id as number,
      roleTitle: 'Role',
      roleNorm: 'role',
    })
    .returning()
  const [set] = await tx
    .insert(criteriaSet)
    .values({ name: `test-set-${token}`, version: setVersion })
    .returning()
  const [req] = await tx
    .insert(requirement)
    .values({ criteriaSetId: set?.id as number, key: 'first', label: 'First', anchors: ANCHORS })
    .returning()
  return {
    postingId: role?.id as number,
    setId: set?.id as number,
    requirementId: req?.id as number,
  }
}

async function insertScore(tx: Tx, postingId: number, criteriaSetId: number, scoredAt?: string) {
  const [score] = await tx
    .insert(postingScore)
    .values({ postingId, criteriaSetId, ...(scoredAt ? { scoredAt } : {}) })
    .returning()
  return score as NonNullable<typeof score>
}

describe('scores, ratings and penalties', () => {
  test('a rating is one row per requirement, not a column', async () => {
    // Arrange / Act: a requirement added after the score exists, with no schema change
    const stored = await rolledBack(async (tx, token) => {
      const ids = await seed(tx, token)
      const score = await insertScore(tx, ids.postingId, ids.setId)
      await tx.insert(postingRating).values({ scoreId: score.id, criteriaSetId: ids.setId, requirementId: ids.requirementId, coverage: 0.5 })
      const [added] = await tx
        .insert(requirement)
        .values({ criteriaSetId: ids.setId, key: 'added-later', label: 'Added later', anchors: ANCHORS })
        .returning()
      await tx
        .insert(postingRating)
        .values({ scoreId: score.id, criteriaSetId: ids.setId, requirementId: added?.id as number, coverage: 1, evidence: 'stated in the posting' })
      const rows = await tx.select().from(postingRating).where(eq(postingRating.scoreId, score.id))
      return { rows, addedId: added?.id }
    })

    // Assert
    expect(stored.rows).toHaveLength(2)
    expect(stored.rows.map((row) => row.requirementId)).toContain(stored.addedId as number)
  })

  test('a rating accepts a null coverage', async () => {
    // Arrange / Act
    const { unrated, zero } = await rolledBack(async (tx, token) => {
      const ids = await seed(tx, token)
      const score = await insertScore(tx, ids.postingId, ids.setId)
      const [second] = await tx
        .insert(requirement)
        .values({ criteriaSetId: ids.setId, key: 'second', label: 'Second', anchors: ANCHORS })
        .returning()
      const [unrated] = await tx
        .insert(postingRating)
        .values({ scoreId: score.id, criteriaSetId: ids.setId, requirementId: ids.requirementId, coverage: null })
        .returning()
      const [zero] = await tx
        .insert(postingRating)
        .values({ scoreId: score.id, criteriaSetId: ids.setId, requirementId: second?.id as number, coverage: 0 })
        .returning()
      return { unrated, zero }
    })

    // Assert: null is not rated, 0 is rated and not covered; they must stay different values
    expect(unrated?.coverage).toBeNull()
    expect(unrated?.confidence).toBe('unknown')
    expect(zero?.coverage).toBe(0)
  })

  test('coverage outside 0..1 is rejected', async () => {
    // Arrange / Act
    const outcome = await rolledBack(async (tx, token) => {
      const ids = await seed(tx, token)
      const score = await insertScore(tx, ids.postingId, ids.setId)
      const tryCoverage = async (key: string, coverage: number) => {
        const [req] = await tx
          .insert(requirement)
          .values({ criteriaSetId: ids.setId, key, label: key, anchors: ANCHORS })
          .returning()
        return thrownInSavepoint(tx, (inner) =>
          inner.insert(postingRating).values({ scoreId: score.id, criteriaSetId: ids.setId, requirementId: req?.id as number, coverage }),
        )
      }
      return {
        tooHigh: await tryCoverage('high', 1.01),
        negative: await tryCoverage('low', -0.01),
        lowerEdge: await tryCoverage('zero', 0),
        upperEdge: await tryCoverage('one', 1),
      }
    })

    // Assert
    expect(violationText(outcome.tooHigh)).toContain('posting_rating_coverage_check')
    expect(violationText(outcome.negative)).toContain('posting_rating_coverage_check')
    expect(outcome.lowerEdge).toBeUndefined()
    expect(outcome.upperEdge).toBeUndefined()
  })

  test('a penalty amount above zero is rejected', async () => {
    // Arrange / Act
    const outcome = await rolledBack(async (tx, token) => {
      const ids = await seed(tx, token)
      const score = await insertScore(tx, ids.postingId, ids.setId)
      const kinds = await tx
        .insert(penaltyKind)
        .values([{ label: `test-kind-a-${token}` }, { label: `test-kind-b-${token}` }, { label: `test-kind-c-${token}` }])
        .returning()
      const attempt = (index: number, amount: number) =>
        thrownInSavepoint(tx, (inner) =>
          inner.insert(postingPenalty).values({ scoreId: score.id, penaltyKindId: kinds[index]?.id as number, amount }),
        )
      return { positive: await attempt(0, 0.1), negative: await attempt(1, -0.25), zero: await attempt(2, 0) }
    })

    // Assert: a penalty only ever takes points off
    expect(violationText(outcome.positive)).toContain('posting_penalty_amount_check')
    expect(outcome.negative).toBeUndefined()
    expect(outcome.zero).toBeUndefined()
  })

  test('one posting holds scores against several criteria sets', async () => {
    // Arrange / Act
    const rows = await rolledBack(async (tx, token) => {
      const ids = await seed(tx, token)
      const [otherSet] = await tx
        .insert(criteriaSet)
        .values({ name: `test-set-${token}`, version: 2 })
        .returning()
      await insertScore(tx, ids.postingId, ids.setId)
      await insertScore(tx, ids.postingId, otherSet?.id as number)
      return tx.select().from(postingScore).where(eq(postingScore.postingId, ids.postingId))
    })

    // Assert: same posting and same day, different sets, so both rows stand
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((row) => row.criteriaSetId)).size).toBe(2)
  })

  test('re-scoring the same posting and set on the same day is a no-op', async () => {
    // Arrange / Act
    const { duplicate, noOp, nextDay, rows } = await rolledBack(async (tx, token) => {
      const ids = await seed(tx, token)
      await insertScore(tx, ids.postingId, ids.setId, '2026-01-10')
      const base = { postingId: ids.postingId, criteriaSetId: ids.setId, scoredAt: '2026-01-10' }
      const duplicate = await thrownInSavepoint(tx, (inner) => inner.insert(postingScore).values(base))
      const noOp = await tx.insert(postingScore).values(base).onConflictDoNothing().returning()
      const nextDay = await thrownInSavepoint(tx, (inner) =>
        inner.insert(postingScore).values({ ...base, scoredAt: '2026-01-11', isRescore: true }),
      )
      const rows = await tx.select().from(postingScore).where(eq(postingScore.postingId, ids.postingId))
      return { duplicate, noOp, nextDay, rows }
    })

    // Assert: the same-day insert collides; a genuine re-score on another day is a new row
    expect(violationText(duplicate)).toContain('posting_score_posting_set_day_unique')
    expect(noOp).toEqual([])
    expect(nextDay).toBeUndefined()
    expect(rows).toHaveLength(2)
  })

  test('limiter_is_unknown defaults to false', async () => {
    // Arrange / Act
    const score = await rolledBack(async (tx, token) => {
      const ids = await seed(tx, token)
      return insertScore(tx, ids.postingId, ids.setId)
    })

    // Assert: a bare score row claims nothing about its limiter or its recommendation
    expect(score.limiterIsUnknown).toBe(false)
    expect(score.recommendApply).toBe(false)
    expect(score.isRescore).toBe(false)
    expect(score.overall).toBeNull()
    expect(score.limiterRequirementId).toBeNull()
  })

  test('the migration passes the lint', () => {
    // Arrange
    const migration = join(MIGRATIONS_DIR, '0003_scores.sql')

    // Act
    const findings = lintMigrations(MIGRATIONS_DIR).filter((finding) => finding.file === migration)

    // Assert: the file must exist, or "no findings" would pass for the wrong reason
    expect(existsSync(migration)).toBe(true)
    expect(findings).toEqual([])
  })
})

describe('a score only holds what belongs to its own criteria set', () => {
  /** A second set with one requirement of its own, to be the wrong set. */
  async function otherSetRequirement(tx: Tx, token: string) {
    const [otherSet] = await tx.insert(criteriaSet).values({ name: `test-set-${token}`, version: 2 }).returning()
    const [req] = await tx
      .insert(requirement)
      .values({ criteriaSetId: otherSet?.id as number, key: 'elsewhere', label: 'Elsewhere', anchors: ANCHORS })
      .returning()
    return { otherSetId: otherSet?.id as number, otherRequirementId: req?.id as number }
  }

  test('a rating for a requirement of another criteria set is rejected', async () => {
    // Arrange / Act
    const outcome = await rolledBack(async (tx, token) => {
      const ids = await seed(tx, token)
      const other = await otherSetRequirement(tx, token)
      const score = await insertScore(tx, ids.postingId, ids.setId)
      const rate = (criteriaSetId: number, requirementId: number) =>
        thrownInSavepoint(tx, (inner) =>
          inner.insert(postingRating).values({ scoreId: score.id, criteriaSetId, requirementId, coverage: 1 }),
        )
      return {
        // Claims its own set, but the requirement lives in the other one
        wrongRequirement: await rate(ids.setId, other.otherRequirementId),
        // Names the requirement's real set, but the score was made under a different one
        wrongScore: await rate(other.otherSetId, other.otherRequirementId),
        correct: await rate(ids.setId, ids.requirementId),
      }
    })

    // Assert: both halves of the pair are enforced, and the matching case is unaffected
    expect(violationText(outcome.wrongRequirement)).toContain('posting_rating_set_requirement_fk')
    expect(violationText(outcome.wrongScore)).toContain('posting_rating_score_set_fk')
    expect(outcome.correct).toBeUndefined()
  })

  test('a limiter or runner-up from another criteria set is rejected', async () => {
    // Arrange / Act
    const outcome = await rolledBack(async (tx, token) => {
      const ids = await seed(tx, token)
      const other = await otherSetRequirement(tx, token)
      const base = { postingId: ids.postingId, criteriaSetId: ids.setId }
      const attempt = (day: string, extra: { limiterRequirementId?: number; runnerUpRequirementId?: number }) =>
        thrownInSavepoint(tx, (inner) => inner.insert(postingScore).values({ ...base, scoredAt: day, ...extra }))
      return {
        limiter: await attempt('2026-02-01', { limiterRequirementId: other.otherRequirementId }),
        runnerUp: await attempt('2026-02-02', { runnerUpRequirementId: other.otherRequirementId }),
        own: await attempt('2026-02-03', {
          limiterRequirementId: ids.requirementId,
          runnerUpRequirementId: ids.requirementId,
        }),
      }
    })

    // Assert: a limiter naming a requirement outside the scored set would be a wrong answer with no error
    expect(violationText(outcome.limiter)).toContain('posting_score_limiter_set_fk')
    expect(violationText(outcome.runnerUp)).toContain('posting_score_runner_up_set_fk')
    expect(outcome.own).toBeUndefined()
  })

  test('a penalty needs a kind, and a kind applies once per score', async () => {
    // Arrange / Act
    const outcome = await rolledBack(async (tx, token) => {
      const ids = await seed(tx, token)
      const score = await insertScore(tx, ids.postingId, ids.setId)
      const [kind] = await tx.insert(penaltyKind).values({ label: `test-kind-${token}` }).returning()
      const kindId = kind?.id as number
      const missing = await thrownInSavepoint(tx, (inner) =>
        inner.insert(postingPenalty).values({ scoreId: score.id, amount: -0.1 } as never),
      )
      const first = await thrownInSavepoint(tx, (inner) =>
        inner.insert(postingPenalty).values({ scoreId: score.id, penaltyKindId: kindId, amount: -0.1 }),
      )
      const again = await thrownInSavepoint(tx, (inner) =>
        inner.insert(postingPenalty).values({ scoreId: score.id, penaltyKindId: kindId, amount: -0.2 }),
      )
      return { missing, first, again }
    })

    // Assert: an empty registry means no penalty rows, not penalty rows without a kind
    expect(violationText(outcome.missing)).toContain('penalty_kind_id')
    expect(outcome.first).toBeUndefined()
    expect(violationText(outcome.again)).toContain('posting_penalty_score_kind_unique')
  })
})

describe('numeric columns read back as numbers', () => {
  test('a stored coverage is a number the rating schema accepts', async () => {
    // Arrange / Act
    const read = await rolledBack(async (tx, token) => {
      const ids = await seed(tx, token)
      const score = await insertScore(tx, ids.postingId, ids.setId)
      await tx
        .insert(postingRating)
        .values({ scoreId: score.id, criteriaSetId: ids.setId, requirementId: ids.requirementId, coverage: 0.35, confidence: 'supported' })
      const [rating] = await tx.select().from(postingRating).where(eq(postingRating.scoreId, score.id))
      return rating as NonNullable<typeof rating>
    })

    // Assert: typeof pins the runtime type, because toBe(0.35) alone would reject a string
    // too but would not say why; and the parse is the boundary Task 5 made mandatory
    expect(typeof read.coverage).toBe('number')
    expect(read.coverage).toBe(0.35)
    const parsed = RatingSchema.parse({ requirementKey: 'first', coverage: read.coverage, confidence: read.confidence })
    expect(parsed.coverage).toBe(0.35)
  })

  test('a stored penalty amount is a number the penalty schema accepts', async () => {
    // Arrange / Act
    const read = await rolledBack(async (tx, token) => {
      const ids = await seed(tx, token)
      const score = await insertScore(tx, ids.postingId, ids.setId)
      const [kind] = await tx.insert(penaltyKind).values({ label: `test-kind-${token}` }).returning()
      await tx.insert(postingPenalty).values({ scoreId: score.id, penaltyKindId: kind?.id as number, amount: -0.25 })
      const [penalty] = await tx.select().from(postingPenalty).where(eq(postingPenalty.scoreId, score.id))
      return penalty as NonNullable<typeof penalty>
    })

    // Assert
    expect(typeof read.amount).toBe('number')
    expect(read.amount).toBe(-0.25)
    expect(PenaltySchema.parse({ kindKey: 'k', amount: read.amount }).amount).toBe(-0.25)
  })

  test('a stored score reads its 0..1 columns back as numbers', async () => {
    // Arrange / Act
    const read = await rolledBack(async (tx, token) => {
      const ids = await seed(tx, token)
      const [stored] = await tx
        .insert(postingScore)
        .values({
          postingId: ids.postingId,
          criteriaSetId: ids.setId,
          overall: 0.7,
          floor: 0.1,
          ceiling: 0.9,
          limiterCoverage: 0.3,
        })
        .returning()
      return stored as NonNullable<typeof stored>
    })

    // Assert
    expect([read.overall, read.floor, read.ceiling, read.limiterCoverage].map((value) => typeof value)).toEqual([
      'number',
      'number',
      'number',
      'number',
    ])
    expect([read.overall, read.floor, read.ceiling, read.limiterCoverage]).toEqual([0.7, 0.1, 0.9, 0.3])
  })

  test('the criteria columns read back as numbers and money stays a string', async () => {
    // Arrange / Act
    const read = await rolledBack(async (tx, token) => {
      const [set] = await tx
        .insert(criteriaSet)
        .values({ name: `test-set-${token}`, version: 1, applyThreshold: 0.6 })
        .returning()
      const [req] = await tx
        .insert(requirement)
        .values({ criteriaSetId: set?.id as number, key: 'r', label: 'R', anchors: ANCHORS, weight: 1.5 })
        .returning()
      const [way] = await tx
        .insert(detour)
        .values({ requirementId: req?.id as number, label: 'Way round', discount: 0.4, costAmount: '120.50' })
        .returning()
      return { set, req, way }
    })

    // Assert: costAmount is money, so a float is the wrong shape for it
    expect(read.set?.applyThreshold).toBe(0.6)
    expect(read.req?.weight).toBe(1.5)
    expect(read.way?.discount).toBe(0.4)
    expect(typeof read.way?.costAmount).toBe('string')
    expect(read.way?.costAmount).toBe('120.50')
    expect(DetourSchema.parse({ requirementKey: 'r', label: 'x', discount: read.way?.discount, coverage: null }).discount).toBe(0.4)
  })
})

describe('the score tables keep the schema free of vocabulary', () => {
  test('no table here has a column named for a criterion, and a penalty always has a kind', async () => {
    // Arrange / Act
    const columns = await rolledBack(async (tx) => {
      const result = await tx.execute(sql`
        SELECT table_name, column_name, is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN ('posting_score', 'posting_rating', 'posting_penalty')`)
      return [...result] as { table_name: string; column_name: string; is_nullable: string }[]
    })

    // Assert: scoped to the three tables this migration owns
    const names = columns.map((column) => column.column_name)
    expect(names).not.toContain('penalty_fintech')
    expect(names).not.toContain('problem_type')
    const kind = columns.find((column) => column.table_name === 'posting_penalty' && column.column_name === 'penalty_kind_id')
    expect(kind?.is_nullable).toBe('NO')
    const coverage = columns.find((column) => column.table_name === 'posting_rating' && column.column_name === 'coverage')
    expect(coverage?.is_nullable).toBe('YES')
  })
})
