import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { asc, eq } from 'drizzle-orm'

import { lintMigrations } from '../../drizzle/lint/migration-lint'
import { closeDb } from '../../src/data/client.ts'
import { criteriaSet } from '../../src/data/schema/criteria.ts'
import { appConfig, pendingRescore, rescoreRequest } from '../../src/data/schema/config.ts'
import { company, normaliseName, position } from '../../src/data/schema/positions.ts'
import { positionScore } from '../../src/data/schema/scores.ts'
import { rolledBack, type Tx } from './rolled-back.ts'

const MIGRATIONS_DIR = join(import.meta.dir, '..', '..', 'drizzle')
const SINCE = '2026-03-10'
const BEFORE_SINCE = '2026-03-09'
const AFTER_SINCE = '2026-03-11'

afterAll(async () => {
  await closeDb()
})

async function addCriteriaSet(tx: Tx, token: string, name: string): Promise<number> {
  const [row] = await tx.insert(criteriaSet).values({ name: `${name} ${token}` }).returning()
  return row!.id
}

/** A position first seen on `seenAt`; the company is created alongside it. */
async function addPosition(tx: Tx, token: string, name: string, seenAt: string): Promise<number> {
  const [owner] = await tx
    .insert(company)
    .values({ name: `${name} ${token}`, nameNorm: normaliseName(`${name} ${token}`) })
    .returning()
  const [target] = await tx
    .insert(position)
    .values({
      positionKey: `${name}-${token}`,
      companyId: owner!.id,
      roleTitle: 'Staff Engineer',
      roleNorm: normaliseName('Staff Engineer'),
      seenAt,
    })
    .returning()
  return target!.id
}

async function addRequest(tx: Tx, criteriaSetId: number, sinceDate: string): Promise<number> {
  const [row] = await tx.insert(rescoreRequest).values({ criteriaSetId, sinceDate }).returning()
  return row!.id
}

/** The position ids the view lists for one request, in a stable order. */
async function pendingFor(tx: Tx, requestId: number): Promise<number[]> {
  const rows = await tx
    .select()
    .from(pendingRescore)
    .where(eq(pendingRescore.rescoreRequestId, requestId))
    .orderBy(asc(pendingRescore.positionId))
  return rows.map((row) => row.positionId)
}

describe('app config and the pending re-score view', () => {
  test('app_config stores the criteria mode', async () => {
    // Arrange / Act
    const { versioned, perspective } = await rolledBack(async (tx) => {
      const read = async (mode: string) => {
        await tx
          .insert(appConfig)
          .values({ key: 'criteria_mode', value: mode })
          .onConflictDoUpdate({ target: appConfig.key, set: { value: mode } })
        const [row] = await tx.select().from(appConfig).where(eq(appConfig.key, 'criteria_mode'))
        return row
      }
      return { versioned: await read('versioned'), perspective: await read('perspective') }
    })

    // Assert: the value comes back as stored, and a second write replaces the first
    expect(versioned?.value).toBe('versioned')
    expect(perspective?.value).toBe('perspective')
  })

  test('pending_rescore lists positions seen on or after since_date with no score for the set', async () => {
    // Arrange / Act
    const { pending, onSince, afterSince } = await rolledBack(async (tx, token) => {
      const setId = await addCriteriaSet(tx, token, 'Set A')
      const requestId = await addRequest(tx, setId, SINCE)
      const onSince = await addPosition(tx, token, 'on-since', SINCE)
      const afterSince = await addPosition(tx, token, 'after-since', AFTER_SINCE)
      return { pending: await pendingFor(tx, requestId), onSince, afterSince }
    })

    // Assert: the boundary day counts, and so does a later day
    expect(pending).toEqual([onSince, afterSince])
  })

  test('pending_rescore excludes a position already scored against that set', async () => {
    // Arrange / Act
    const { pending, unscored, scoredElsewhere } = await rolledBack(async (tx, token) => {
      const setId = await addCriteriaSet(tx, token, 'Set A')
      const otherSetId = await addCriteriaSet(tx, token, 'Set B')
      const requestId = await addRequest(tx, setId, SINCE)
      const scored = await addPosition(tx, token, 'scored', AFTER_SINCE)
      const unscored = await addPosition(tx, token, 'unscored', AFTER_SINCE)
      const scoredElsewhere = await addPosition(tx, token, 'scored-elsewhere', AFTER_SINCE)
      await tx.insert(positionScore).values([
        { positionId: scored, criteriaSetId: setId },
        { positionId: scoredElsewhere, criteriaSetId: otherSetId },
      ])
      return { pending: await pendingFor(tx, requestId), unscored, scoredElsewhere }
    })

    // Assert: only a score for this request's set removes a position; a score for another set does not
    expect(pending).toEqual([unscored, scoredElsewhere].sort((a, b) => a - b))
  })

  test('pending_rescore excludes a position seen before since_date', async () => {
    // Arrange / Act
    const { pending, recent } = await rolledBack(async (tx, token) => {
      const setId = await addCriteriaSet(tx, token, 'Set A')
      const requestId = await addRequest(tx, setId, SINCE)
      await addPosition(tx, token, 'old', BEFORE_SINCE)
      const recent = await addPosition(tx, token, 'recent', SINCE)
      return { pending: await pendingFor(tx, requestId), recent }
    })

    // Assert: the day before since_date is out, the day itself is in
    expect(pending).toEqual([recent])
  })

  test('scoring a pending position removes it from the view without an update', async () => {
    // Arrange / Act: nothing but the score insert happens between the two reads
    const { before, after, other, requestRow, requestRowAfter } = await rolledBack(async (tx, token) => {
      const setId = await addCriteriaSet(tx, token, 'Set A')
      const requestId = await addRequest(tx, setId, SINCE)
      const target = await addPosition(tx, token, 'target', AFTER_SINCE)
      const other = await addPosition(tx, token, 'other', AFTER_SINCE)
      const before = await pendingFor(tx, requestId)
      const [requestRow] = await tx.select().from(rescoreRequest).where(eq(rescoreRequest.id, requestId))
      await tx.insert(positionScore).values({ positionId: target, criteriaSetId: setId })
      const after = await pendingFor(tx, requestId)
      const [requestRowAfter] = await tx.select().from(rescoreRequest).where(eq(rescoreRequest.id, requestId))
      return { before: { ids: before, target }, after, other, requestRow, requestRowAfter }
    })

    // Assert: the scored position leaves, the other stays, and the request row itself is untouched
    expect(before.ids).toEqual([before.target, other].sort((a, b) => a - b))
    expect(after).toEqual([other])
    expect(requestRowAfter).toEqual(requestRow)
  })

  test('the migration passes the lint', () => {
    // Arrange
    const migration = join(MIGRATIONS_DIR, '0007_config_rescore.sql')

    // Act
    const findings = lintMigrations(MIGRATIONS_DIR).filter((finding) => finding.file === migration)

    // Assert: the file must exist, or "no findings" would pass for the wrong reason
    expect(existsSync(migration)).toBe(true)
    expect(findings).toEqual([])
  })
})
