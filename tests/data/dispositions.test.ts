import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { and, asc, desc, eq, sql } from 'drizzle-orm'

import { lintMigrations } from '../../drizzle/lint/migration-lint'
import { closeDb } from '../../src/data/client.ts'
import { positionDisposition, positionStageEvent } from '../../src/data/schema/dispositions.ts'
import { company, normaliseName, position } from '../../src/data/schema/positions.ts'
import { rejectionReason, setAsideReason, stage } from '../../src/data/schema/registries.ts'
import { rolledBack, thrownInSavepoint, violationText, type Tx } from './rolled-back.ts'

const MIGRATIONS_DIR = join(import.meta.dir, '..', '..', 'drizzle')
const DISPOSITION_CHECK = 'position_disposition_kind_reason_check'

afterAll(async () => {
  await closeDb()
})

/** A position, one reason of each kind and two stages (one repeatable), all inside `tx`. */
async function seed(tx: Tx, token: string) {
  const [owner] = await tx
    .insert(company)
    .values({ name: `Test Co ${token}`, nameNorm: normaliseName(`Test Co ${token}`) })
    .returning()
  const [target] = await tx
    .insert(position)
    .values({
      positionKey: `test-position-${token}`,
      companyId: owner!.id,
      roleTitle: 'Staff Engineer',
      roleNorm: normaliseName('Staff Engineer'),
    })
    .returning()
  const [aside] = await tx.insert(setAsideReason).values({ label: `aside-${token}` }).returning()
  const [rejected] = await tx.insert(rejectionReason).values({ label: `rejected-${token}` }).returning()
  const [open] = await tx
    .insert(stage)
    .values({ key: `open-${token}`, label: 'An open stage', isTerminal: false })
    .returning()
  const [repeating] = await tx
    .insert(stage)
    .values({ key: `repeating-${token}`, label: 'A repeatable stage', isRepeatable: true })
    .returning()
  return {
    positionId: target!.id,
    setAsideReasonId: aside!.id,
    rejectionReasonId: rejected!.id,
    openStage: open!,
    repeatingStage: repeating!,
  }
}

describe('dispositions and stage history', () => {
  test('a set-aside disposition requires a set-aside reason', async () => {
    // Arrange / Act
    const { withoutReason, withReason, error } = await rolledBack(async (tx, token) => {
      const ids = await seed(tx, token)
      const failure = await thrownInSavepoint(tx, (inner) =>
        inner.insert(positionDisposition).values({ positionId: ids.positionId, kind: 'set_aside' }),
      )
      const [saved] = await tx
        .insert(positionDisposition)
        .values({ positionId: ids.positionId, kind: 'set_aside', setAsideReasonId: ids.setAsideReasonId })
        .returning()
      return { withoutReason: failure, withReason: saved, error: violationText(failure) }
    })

    // Assert: neither reason is refused by the CHECK; the reason makes the same row valid
    expect(withoutReason).toBeInstanceOf(Error)
    expect(error).toContain(DISPOSITION_CHECK)
    expect(withReason?.kind).toBe('set_aside')
    expect(withReason?.rejectionReasonId).toBeNull()
  })

  test('a set-aside disposition rejects a rejection reason', async () => {
    // Arrange / Act
    const { onlyRejection, both } = await rolledBack(async (tx, token) => {
      const ids = await seed(tx, token)
      const attempt = (reasons: { setAsideReasonId?: number; rejectionReasonId?: number }) =>
        thrownInSavepoint(tx, (inner) =>
          inner.insert(positionDisposition).values({ positionId: ids.positionId, kind: 'set_aside', ...reasons }),
        )
      return {
        onlyRejection: await attempt({ rejectionReasonId: ids.rejectionReasonId }),
        both: await attempt({
          setAsideReasonId: ids.setAsideReasonId,
          rejectionReasonId: ids.rejectionReasonId,
        }),
      }
    })

    // Assert: the other author's reason is refused alone, and also next to its own
    expect(violationText(onlyRejection)).toContain(DISPOSITION_CHECK)
    expect(violationText(both)).toContain(DISPOSITION_CHECK)
  })

  test('a rejected disposition requires a rejection reason', async () => {
    // Arrange / Act
    const outcome = await rolledBack(async (tx, token) => {
      const ids = await seed(tx, token)
      const attempt = (values: { kind: string; setAsideReasonId?: number; rejectionReasonId?: number }) =>
        thrownInSavepoint(tx, (inner) =>
          inner.insert(positionDisposition).values({ positionId: ids.positionId, ...values }),
        )
      const [saved] = await tx
        .insert(positionDisposition)
        .values({ positionId: ids.positionId, kind: 'rejected', rejectionReasonId: ids.rejectionReasonId })
        .returning()
      return {
        neither: await attempt({ kind: 'rejected' }),
        onlySetAside: await attempt({ kind: 'rejected', setAsideReasonId: ids.setAsideReasonId }),
        both: await attempt({
          kind: 'rejected',
          setAsideReasonId: ids.setAsideReasonId,
          rejectionReasonId: ids.rejectionReasonId,
        }),
        unknownKind: await attempt({ kind: 'withdrawn', rejectionReasonId: ids.rejectionReasonId }),
        saved,
      }
    })

    // Assert: only the row with exactly its own reason is stored
    expect(violationText(outcome.neither)).toContain(DISPOSITION_CHECK)
    expect(violationText(outcome.onlySetAside)).toContain(DISPOSITION_CHECK)
    expect(violationText(outcome.both)).toContain(DISPOSITION_CHECK)
    expect(violationText(outcome.unknownKind)).toContain(DISPOSITION_CHECK)
    expect(outcome.saved?.kind).toBe('rejected')
    expect(outcome.saved?.setAsideReasonId).toBeNull()
  })

  test('a position carries a disposition independently of its stage', async () => {
    // Arrange / Act
    const { dispositions, events, openStage } = await rolledBack(async (tx, token) => {
      const ids = await seed(tx, token)
      await tx.insert(positionStageEvent).values({ positionId: ids.positionId, stageId: ids.openStage.id })
      await tx
        .insert(positionDisposition)
        .values({ positionId: ids.positionId, kind: 'set_aside', setAsideReasonId: ids.setAsideReasonId })
      return {
        dispositions: await tx
          .select()
          .from(positionDisposition)
          .where(eq(positionDisposition.positionId, ids.positionId)),
        events: await tx.select().from(positionStageEvent).where(eq(positionStageEvent.positionId, ids.positionId)),
        openStage: ids.openStage,
      }
    })

    // Assert: set aside while the stage is non-terminal, and setting aside added no stage event
    expect(openStage.isTerminal).toBe(false)
    expect(dispositions).toHaveLength(1)
    expect(dispositions[0]?.kind).toBe('set_aside')
    expect(events).toHaveLength(1)
    expect(events[0]?.stageId).toBe(openStage.id)
  })

  test('stage events are append-only and the latest one is the current stage', async () => {
    // Arrange / Act
    const { history, current, afterAppend } = await rolledBack(async (tx, token) => {
      const ids = await seed(tx, token)
      const forPosition = eq(positionStageEvent.positionId, ids.positionId)
      await tx.insert(positionStageEvent).values([
        { positionId: ids.positionId, stageId: ids.openStage.id, occurredAt: new Date('2026-01-01T00:00:00Z') },
        { positionId: ids.positionId, stageId: ids.repeatingStage.id, occurredAt: new Date('2026-01-02T00:00:00Z') },
      ])
      const latest = () =>
        tx
          .select()
          .from(positionStageEvent)
          .where(forPosition)
          .orderBy(desc(positionStageEvent.occurredAt), desc(positionStageEvent.id))
          .limit(1)
      const [first] = await latest()
      // Moving back to the earlier stage is a new event, not an edit of the old one
      await tx.insert(positionStageEvent).values({
        positionId: ids.positionId,
        stageId: ids.openStage.id,
        occurredAt: new Date('2026-01-03T00:00:00Z'),
      })
      const [second] = await latest()
      return {
        history: await tx.select().from(positionStageEvent).where(forPosition).orderBy(asc(positionStageEvent.id)),
        current: first,
        afterAppend: second,
      }
    })

    // Assert: the old events are all still there, and the newest decides the current stage
    expect(history).toHaveLength(3)
    expect(history.map((event) => event.stageId)).toEqual([
      history[0]!.stageId,
      history[1]!.stageId,
      history[0]!.stageId,
    ])
    expect(current?.stageId).toBe(history[1]!.stageId)
    expect(afterAppend?.stageId).toBe(history[0]!.stageId)
    expect(afterAppend?.id).toBe(history[2]!.id)
  })

  test('stage events at the same instant order by id, so the last appended is current', async () => {
    // Arrange / Act: inside one transaction now() is constant, so default timestamps tie
    const { current, ids } = await rolledBack(async (tx, token) => {
      const seeded = await seed(tx, token)
      await tx.insert(positionStageEvent).values({ positionId: seeded.positionId, stageId: seeded.openStage.id })
      await tx.insert(positionStageEvent).values({ positionId: seeded.positionId, stageId: seeded.repeatingStage.id })
      const [latest] = await tx
        .select()
        .from(positionStageEvent)
        .where(eq(positionStageEvent.positionId, seeded.positionId))
        .orderBy(desc(positionStageEvent.occurredAt), desc(positionStageEvent.id))
        .limit(1)
      return { current: latest, ids: seeded }
    })

    // Assert
    expect(current?.stageId).toBe(ids.repeatingStage.id)
  })

  test('a repeatable stage can occur more than once for one position', async () => {
    // Arrange / Act
    const { repeats, total } = await rolledBack(async (tx, token) => {
      const ids = await seed(tx, token)
      const events = [ids.repeatingStage.id, ids.openStage.id, ids.repeatingStage.id, ids.repeatingStage.id].map(
        (stageId, index) => ({
          positionId: ids.positionId,
          stageId,
          occurredAt: new Date(Date.UTC(2026, 0, index + 1)),
        }),
      )
      await tx.insert(positionStageEvent).values(events)
      const forPosition = eq(positionStageEvent.positionId, ids.positionId)
      return {
        repeats: await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(positionStageEvent)
          .where(and(forPosition, eq(positionStageEvent.stageId, ids.repeatingStage.id))),
        total: await tx.select({ count: sql<number>`count(*)::int` }).from(positionStageEvent).where(forPosition),
      }
    })

    // Assert: the same stage three times is stored three times, and the process has four steps
    expect(repeats[0]?.count).toBe(3)
    expect(total[0]?.count).toBe(4)
  })

  test('the migration passes the lint', () => {
    // Arrange
    const migration = join(MIGRATIONS_DIR, '0004_dispositions.sql')

    // Act
    const findings = lintMigrations(MIGRATIONS_DIR).filter((finding) => finding.file === migration)

    // Assert: the file must exist, or "no findings" would pass for the wrong reason
    expect(existsSync(migration)).toBe(true)
    expect(findings).toEqual([])
  })
})
