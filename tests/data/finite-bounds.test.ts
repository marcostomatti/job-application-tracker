import { describe, expect, test } from 'bun:test'

import { criteriaSet, requirement } from '../../src/data/schema/criteria.ts'
import { company, posting } from '../../src/data/schema/postings.ts'
import { penaltyKind } from '../../src/data/schema/registries.ts'
import { postingPenalty, postingScore } from '../../src/data/schema/scores.ts'
import { thrownBy, violationText } from './rolled-back.ts'
import { withMigratedScratchDatabase } from './scratch-database.ts'

const ANCHORS = { '0': 'does not meet it', '0.5': 'partly meets it', '1': 'fully meets it' }

/**
 * A weight and a penalty amount are numbers the scoring divides by and sums, so the database
 * must keep them finite. Postgres orders NaN above every number and Infinity above every
 * finite one, which is why a one-sided `>= 0` or `<= 0` lets them in.
 * These run on a scratch database built from the migrations alone.
 */
describe('weights and penalty amounts are finite', () => {
  test('a requirement weight of Infinity or NaN is rejected, a finite weight is not', async () => {
    // Arrange / Act
    const outcome = await withMigratedScratchDatabase(async (db) => {
      const [set] = await db.insert(criteriaSet).values({ name: 'finite-weights', version: 1 }).returning()
      const insertWeight = (key: string, weight: number) =>
        thrownBy(() =>
          db.insert(requirement).values({ criteriaSetId: set?.id as number, key, label: key, anchors: ANCHORS, weight }),
        )
      return {
        infinite: await insertWeight('infinite', Number.POSITIVE_INFINITY),
        notANumber: await insertWeight('nan', Number.NaN),
        finite: await insertWeight('finite', 0.4),
        zero: await insertWeight('zero', 0),
      }
    })

    // Assert: Infinity / Infinity would make the overall NaN, which Review Focus 1 forbids
    expect(violationText(outcome.infinite)).toContain('requirement_weight_check')
    expect(violationText(outcome.notANumber)).toContain('requirement_weight_check')
    expect(outcome.finite).toBeUndefined()
    expect(outcome.zero).toBeUndefined()
  })

  test('a penalty amount of -Infinity or NaN is rejected, a finite amount is not', async () => {
    // Arrange / Act
    const outcome = await withMigratedScratchDatabase(async (db) => {
      const [owner] = await db.insert(company).values({ name: 'finite-co', nameNorm: 'finite-co' }).returning()
      const [role] = await db
        .insert(posting)
        .values({ postingKey: 'finite-posting', companyId: owner?.id as number, roleTitle: 'Role', roleNorm: 'role' })
        .returning()
      const [set] = await db.insert(criteriaSet).values({ name: 'finite-amounts', version: 1 }).returning()
      const [score] = await db
        .insert(postingScore)
        .values({ postingId: role?.id as number, criteriaSetId: set?.id as number })
        .returning()
      const kinds = await db
        .insert(penaltyKind)
        .values(['a', 'b', 'c', 'd'].map((label) => ({ label: `finite-kind-${label}` })))
        .returning()
      const insertAmount = (index: number, amount: number) =>
        thrownBy(() =>
          db
            .insert(postingPenalty)
            .values({ scoreId: score?.id as number, penaltyKindId: kinds[index]?.id as number, amount }),
        )
      return {
        negativeInfinity: await insertAmount(0, Number.NEGATIVE_INFINITY),
        notANumber: await insertAmount(1, Number.NaN),
        finite: await insertAmount(2, -0.25),
        zero: await insertAmount(3, 0),
      }
    })

    // Assert
    expect(violationText(outcome.negativeInfinity)).toContain('posting_penalty_amount_check')
    expect(violationText(outcome.notANumber)).toContain('posting_penalty_amount_check')
    expect(outcome.finite).toBeUndefined()
    expect(outcome.zero).toBeUndefined()
  })
})
