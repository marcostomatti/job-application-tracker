import { describe, expect, test } from 'bun:test'
import { count, eq } from 'drizzle-orm'

import type { DrizzleClient } from '../../../src/data/client.ts'
import { addPositions } from '../../../src/data/repositories/positions.ts'
import { addRegistryRows, archiveRegistryRow } from '../../../src/data/repositories/registries.ts'
import { positionStageEvent } from '../../../src/data/schema/dispositions.ts'
import { dispositionTools } from '../../../src/mcp/tools/dispositions.ts'
import { provenanceTools } from '../../../src/mcp/tools/provenance.ts'
import { textTools } from '../../../src/mcp/tools/texts.ts'
import { BULK_MAX } from '../../../src/schemas/common.ts'
import { connectTools, failureText, idOf, untouchableDb, useSharedScratchDatabase } from './harness.ts'

const database = useSharedScratchDatabase()

async function newPositionId(title: string): Promise<number> {
  return idOf(await addPositions(database(), [{ company: { name: `${title} Co` }, roleTitle: title }]))
}

/** A stage with the flags given; the registry ships empty, so every test makes the one it reads. */
async function newStageId(key: string, flags: { isApplied?: boolean } = {}): Promise<number> {
  return idOf(await addRegistryRows(database(), 'stage', [{ key, label: key, ...flags }]))
}

async function eventCount(db: DrizzleClient, positionId: number): Promise<number> {
  const [found] = await db.select({ n: count() }).from(positionStageEvent).where(eq(positionStageEvent.positionId, positionId))
  return found?.n ?? 0
}

describe('the dispositions group', () => {
  test('the dispositions group registers exactly the named tools', () => {
    expect(dispositionTools.map((tool) => tool.name).sort()).toEqual([
      'position_reject',
      'position_set_aside',
      'set_aside_list',
      'stage_append',
      'stage_append_bulk',
      'stage_current',
    ])
  })

  test('there is no tool that updates or deletes a stage event', () => {
    const everyTool = [...dispositionTools, ...provenanceTools, ...textTools]

    const names = everyTool.map((tool) => tool.name)

    expect(names.filter((name) => /stage_(update|delete|remove)/.test(name))).toEqual([])
    expect(names.filter((name) => /stage/.test(name)).sort()).toEqual(['stage_append', 'stage_append_bulk', 'stage_current'])
  })

  test('no tool sets annotations, which are left for the author to decide', () => {
    expect(dispositionTools.filter((tool) => tool.annotations !== undefined)).toEqual([])
  })

  test('stage_current is null for a position with no event, and not-found for no position', async () => {
    const client = await connectTools(dispositionTools, database())
    const positionId = await newPositionId('No events')

    const none = await client.call('stage_current', { positionId })
    const missing = await client.call('stage_current', { positionId: 999_999 })

    expect(none).toEqual({ failed: false, body: null })
    expect(missing.failed).toBe(true)
    expect(failureText(missing)).toContain('position 999999 does not exist')
  })

  test('stage_append records an event and stage_current returns it with the stage and its flags', async () => {
    const client = await connectTools(dispositionTools, database())
    const positionId = await newPositionId('Appended')
    const stageId = await newStageId('appended-stage', { isApplied: true })

    const appended = await client.call('stage_append', { positionId, stageId, note: 'Sent the form' })
    const current = await client.call('stage_current', { positionId })

    expect(appended.body).toMatchObject({ positionId, stageId, note: 'Sent the form' })
    expect(current.body).toMatchObject({ event: { positionId, stageId }, stage: { id: stageId, isApplied: true } })
  })

  test('stage_append takes a null stage, which stage_current reports as no stage yet', async () => {
    const client = await connectTools(dispositionTools, database())
    const positionId = await newPositionId('Null stage')

    const appended = await client.call('stage_append', { positionId, stageId: null })
    const current = await client.call('stage_current', { positionId })

    expect(appended.body).toMatchObject({ positionId, stageId: null })
    expect(current).toEqual({ failed: false, body: null })
  })

  test('stage_append never replaces an earlier event: the latest by occurredAt is current and both are kept', async () => {
    const client = await connectTools(dispositionTools, database())
    const positionId = await newPositionId('Backdated')
    const later = await newStageId('later-stage')
    const earlier = await newStageId('earlier-stage')
    await client.call('stage_append', { positionId, stageId: later, occurredAt: '2026-06-02T10:00:00Z' })

    await client.call('stage_append', { positionId, stageId: earlier, occurredAt: '2026-06-01T10:00:00Z' })
    const current = await client.call('stage_current', { positionId })

    expect(current.body).toMatchObject({ event: { stageId: later } })
    expect(await eventCount(database(), positionId)).toBe(2)
  })

  test('stage_append refuses an archived stage and an unknown position, and writes nothing', async () => {
    const client = await connectTools(dispositionTools, database())
    const positionId = await newPositionId('Refused')
    const archived = await newStageId('archived-stage')
    await archiveRegistryRow(database(), 'stage', archived)

    const archivedOutcome = await client.call('stage_append', { positionId, stageId: archived })
    const missing = await client.call('stage_append', { positionId: 999_999, stageId: null })

    expect(failureText(archivedOutcome)).toContain(`stage ${archived} is archived`)
    expect(failureText(missing)).toContain('position 999999 does not exist')
    expect(await eventCount(database(), positionId)).toBe(0)
  })

  test('stage_append refuses a missing stageId and a time without an offset, before touching the database', async () => {
    const client = await connectTools(dispositionTools, untouchableDb())

    const noStage = await client.call('stage_append', { positionId: 1 })
    const noOffset = await client.call('stage_append', { positionId: 1, stageId: null, occurredAt: '2026-06-01T10:00:00' })

    expect([noStage.failed, noOffset.failed]).toEqual([true, true])
    expect(failureText(noStage)).toContain('stageId')
  })

  test('stage_append_bulk records events in the order given', async () => {
    const client = await connectTools(dispositionTools, database())
    const first = await newPositionId('Bulk one')
    const second = await newPositionId('Bulk two')
    const stageId = await newStageId('bulk-stage')

    const outcome = await client.call('stage_append_bulk', {
      items: [second, first].map((positionId) => ({ positionId, stageId })),
    })

    expect(outcome.body).toEqual([
      expect.objectContaining({ positionId: second, stageId }),
      expect.objectContaining({ positionId: first, stageId }),
    ])
  })

  test('stage_append_bulk names the failing item by index and records none of the batch', async () => {
    const client = await connectTools(dispositionTools, database())
    const positionId = await newPositionId('Bulk rollback')

    const outcome = await client.call('stage_append_bulk', {
      items: [
        { positionId, stageId: null },
        { positionId: 999_999, stageId: null },
      ],
    })

    expect(failureText(outcome)).toContain('bulk item 1 failed: position 999999 does not exist')
    expect(await eventCount(database(), positionId)).toBe(0)
  })

  test('stage_append_bulk rejects an over-cap array, an empty one and a single item at the schema', async () => {
    const client = await connectTools(dispositionTools, untouchableDb())
    const item = { positionId: 1, stageId: null }

    const over = await client.call('stage_append_bulk', { items: Array.from({ length: BULK_MAX + 1 }, () => item) })
    const empty = await client.call('stage_append_bulk', { items: [] })
    const single = await client.call('stage_append_bulk', item)

    expect([over.failed, empty.failed, single.failed]).toEqual([true, true, true])
  })

  test('position_set_aside records the reason, and requires one that is not archived', async () => {
    const client = await connectTools(dispositionTools, database())
    const positionId = await newPositionId('Set aside')
    const reasonId = idOf(await addRegistryRows(database(), 'set_aside_reason', [{ label: 'Recorded reason' }]))
    const archivedId = idOf(await addRegistryRows(database(), 'set_aside_reason', [{ label: 'Retired reason' }]))
    await archiveRegistryRow(database(), 'set_aside_reason', archivedId)

    const recorded = await client.call('position_set_aside', { positionId, setAsideReasonId: reasonId, note: 'Too far' })
    const archived = await client.call('position_set_aside', { positionId, setAsideReasonId: archivedId })
    const noReason = await client.call('position_set_aside', { positionId })

    expect(recorded.body).toMatchObject({ positionId, setAsideReasonId: reasonId, note: 'Too far' })
    expect(failureText(archived)).toContain(`set_aside_reason ${archivedId} is archived`)
    expect(noReason.failed).toBe(true)
  })

  test('position_reject records a rejection with its own registry, and leaves the stage alone', async () => {
    const client = await connectTools(dispositionTools, database())
    const positionId = await newPositionId('Rejected')
    const rejectionReasonId = idOf(await addRegistryRows(database(), 'rejection_reason', [{ label: 'No fit' }]))
    const stageId = await newStageId('rejected-stage')
    await client.call('stage_append', { positionId, stageId })

    const rejected = await client.call('position_reject', { positionId, rejectionReasonId })
    const current = await client.call('stage_current', { positionId })
    const wrongField = await client.call('position_reject', { positionId, setAsideReasonId: rejectionReasonId })

    expect(rejected.body).toMatchObject({ positionId, rejectionReasonId })
    expect(current.body).toMatchObject({ stage: { id: stageId } })
    expect(wrongField.failed).toBe(true)
  })

  test('position_set_aside and position_reject for an unknown position are not-found errors', async () => {
    const client = await connectTools(dispositionTools, database())
    const setAsideReasonId = idOf(await addRegistryRows(database(), 'set_aside_reason', [{ label: 'Unknown pos aside' }]))
    const rejectionReasonId = idOf(await addRegistryRows(database(), 'rejection_reason', [{ label: 'Unknown pos reject' }]))

    const aside = await client.call('position_set_aside', { positionId: 999_999, setAsideReasonId })
    const rejected = await client.call('position_reject', { positionId: 999_999, rejectionReasonId })

    expect(failureText(aside)).toContain('position 999999 does not exist')
    expect(failureText(rejected)).toContain('position 999999 does not exist')
  })

  test('set_aside_list groups by reason and names each reason label', async () => {
    const client = await connectTools(dispositionTools, database())
    const distance = idOf(await addRegistryRows(database(), 'set_aside_reason', [{ label: 'Grouped: too far' }]))
    const pay = idOf(await addRegistryRows(database(), 'set_aside_reason', [{ label: 'Grouped: low pay' }]))
    const near = await newPositionId('Grouped near')
    const far = await newPositionId('Grouped far')
    const cheap = await newPositionId('Grouped cheap')
    const kept = await newPositionId('Grouped kept')
    await client.call('position_set_aside', { positionId: near, setAsideReasonId: distance })
    await client.call('position_set_aside', { positionId: far, setAsideReasonId: distance })
    await client.call('position_set_aside', { positionId: cheap, setAsideReasonId: pay })

    const outcome = await client.call('set_aside_list', {})

    const groups = (outcome.body as Array<{ reasonId: number; reasonLabel: string; positions: Array<{ position: { id: number } }> }>)
    const idsIn = (reasonId: number): number[] =>
      (groups.find((group) => group.reasonId === reasonId)?.positions ?? []).map((row) => row.position.id).sort()
    expect(groups.find((group) => group.reasonId === distance)?.reasonLabel).toBe('Grouped: too far')
    expect(groups.find((group) => group.reasonId === pay)?.reasonLabel).toBe('Grouped: low pay')
    expect(idsIn(distance)).toEqual([near, far].sort())
    expect(idsIn(pay)).toEqual([cheap])
    expect(groups.flatMap((group) => group.positions).map((row) => row.position.id)).not.toContain(kept)
  })

  test('set_aside_list still renders the label of a reason archived after it was used', async () => {
    const client = await connectTools(dispositionTools, database())
    const reasonId = idOf(await addRegistryRows(database(), 'set_aside_reason', [{ label: 'Archived later' }]))
    const positionId = await newPositionId('Archived reason')
    await client.call('position_set_aside', { positionId, setAsideReasonId: reasonId })
    await archiveRegistryRow(database(), 'set_aside_reason', reasonId)

    const outcome = await client.call('set_aside_list', {})

    expect(outcome.body).toContainEqual(expect.objectContaining({ reasonId, reasonLabel: 'Archived later' }))
  })

  test('set_aside_list takes no arguments and refuses one', async () => {
    const client = await connectTools(dispositionTools, untouchableDb())

    const outcome = await client.call('set_aside_list', { reasonId: 1 })

    expect(outcome.failed).toBe(true)
  })
})
