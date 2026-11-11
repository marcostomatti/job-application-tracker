import { describe, expect, test } from 'bun:test'

import type { DrizzleClient } from '../../../src/data/client.ts'
import { criteriaTools } from '../../../src/mcp/tools/criteria.ts'
import { connectTools, failureText, untouchableDb, useSharedScratchDatabase } from './harness.ts'
import { archiveCriteriaSetForTest, arrangeSet } from './criteria-arrangement.ts'

const database = useSharedScratchDatabase()

type Set = { id: number; name: string; version: number; isDefault: boolean; archivedAt: string | null }
type Req = { id: number; key: string; weight: number | null; label: string; kind: string }

async function arranged(name: string, db: DrizzleClient = database()): Promise<{ setId: number; requirementId: number }> {
  return arrangeSet(db, name)
}

describe('the criteria group', () => {
  test('the criteria group registers exactly the named tools', () => {
    expect(criteriaTools.map((tool) => tool.name).sort()).toEqual([
      'criteria_mode_get',
      'criteria_mode_set',
      'criteria_requirement_add',
      'criteria_requirement_update',
      'criteria_requirements',
      'criteria_set_default',
      'criteria_sets',
      'criteria_version_create',
    ])
  })

  test('no tool sets annotations, which are left for the author to decide', () => {
    expect(criteriaTools.filter((tool) => tool.annotations !== undefined)).toEqual([])
  })

  test('criteria_sets lists live sets and includes archived ones only when asked', async () => {
    const client = await connectTools(criteriaTools, database())
    const live = await arranged('Listed live')
    const retired = await arranged('Listed retired')
    await archiveCriteriaSetForTest(database(), retired.setId)

    const byDefault = await client.call('criteria_sets', {})
    const everything = await client.call('criteria_sets', { includeArchived: true })

    const ids = (outcome: { body: unknown }): number[] => (outcome.body as Set[]).map((row) => row.id)
    expect(ids(byDefault)).toContain(live.setId)
    expect(ids(byDefault)).not.toContain(retired.setId)
    expect(ids(everything)).toContain(retired.setId)
  })

  test('criteria_requirements returns the rubric of one set and a missing set is a not-found error', async () => {
    const client = await connectTools(criteriaTools, database())
    const { setId, requirementId } = await arranged('Rubric')

    const found = await client.call('criteria_requirements', { criteriaSetId: setId })
    const missing = await client.call('criteria_requirements', { criteriaSetId: 999_999 })

    expect(found.body).toEqual([expect.objectContaining({ id: requirementId, key: 'skill', detours: [] })])
    expect(failureText(missing)).toContain('criteria set 999999 does not exist')
  })

  test('criteria_version_create copies a set under the next version and leaves the source alone', async () => {
    const client = await connectTools(criteriaTools, database())
    const { setId } = await arranged('Versioned')

    const created = await client.call('criteria_version_create', { fromSetId: setId })
    const copied = await client.call('criteria_requirements', { criteriaSetId: (created.body as Set).id })

    expect(created.body).toMatchObject({ name: 'Versioned', version: 2, isDefault: false })
    expect((copied.body as Req[]).map((row) => row.key)).toEqual(['skill'])
  })

  test('criteria_version_create can file the copy under a new name, starting at version 1', async () => {
    const client = await connectTools(criteriaTools, database())
    const { setId } = await arranged('Original')

    const created = await client.call('criteria_version_create', { fromSetId: setId, name: 'Renamed' })

    expect(created.body).toMatchObject({ name: 'Renamed', version: 1 })
  })

  test('criteria_requirement_update changes the named fields and an empty patch is refused', async () => {
    const client = await connectTools(criteriaTools, database())
    const { requirementId } = await arranged('Edited')

    const updated = await client.call('criteria_requirement_update', {
      requirementId,
      patch: { weight: 5, label: 'Skill, reworded' },
    })
    const empty = await client.call('criteria_requirement_update', { requirementId, patch: {} })
    const missing = await client.call('criteria_requirement_update', { requirementId: 999_999, patch: { weight: 1 } })

    expect(updated.body).toMatchObject({ id: requirementId, weight: 5, label: 'Skill, reworded', key: 'skill' })
    expect(empty.failed).toBe(true)
    expect(failureText(missing)).toContain('requirement 999999 does not exist')
  })

  test('criteria_set_default makes one set the default and moves the flag off the previous one', async () => {
    const client = await connectTools(criteriaTools, database())
    const first = await arranged('Default one')
    const second = await arranged('Default two')

    const madeFirst = await client.call('criteria_set_default', { criteriaSetId: first.setId })
    const madeSecond = await client.call('criteria_set_default', { criteriaSetId: second.setId })
    const listed = (await client.call('criteria_sets', {})).body as Set[]

    expect(madeFirst.body).toMatchObject({ id: first.setId, isDefault: true })
    expect(madeSecond.body).toMatchObject({ id: second.setId, isDefault: true })
    expect(listed.filter((row) => row.isDefault).map((row) => row.id)).toEqual([second.setId])
  })

  test('criteria_set_default refuses an archived set and leaves the current default in place', async () => {
    const client = await connectTools(criteriaTools, database())
    const current = await arranged('Stays default')
    const retired = await arranged('Retired default')
    await client.call('criteria_set_default', { criteriaSetId: current.setId })
    await archiveCriteriaSetForTest(database(), retired.setId)

    const outcome = await client.call('criteria_set_default', { criteriaSetId: retired.setId })
    const listed = (await client.call('criteria_sets', {})).body as Set[]

    expect(failureText(outcome)).toContain(`criteria set ${retired.setId} is archived`)
    expect(listed.find((row) => row.isDefault)?.id).toBe(current.setId)
  })

  test('criteria_mode_get reports versioned on a fresh install and criteria_mode_set changes it', async () => {
    const client = await connectTools(criteriaTools, database())

    const before = await client.call('criteria_mode_get', {})
    const set = await client.call('criteria_mode_set', { mode: 'perspective' })
    const after = await client.call('criteria_mode_get', {})
    await client.call('criteria_mode_set', { mode: 'versioned' })

    expect(before.body).toEqual({ mode: 'versioned' })
    expect(set.body).toEqual({ mode: 'perspective' })
    expect(after.body).toEqual({ mode: 'perspective' })
  })

  test('criteria_mode_set refuses a mode that does not exist, before touching the database', async () => {
    const client = await connectTools(criteriaTools, untouchableDb())

    const outcome = await client.call('criteria_mode_set', { mode: 'chaos' })

    expect(outcome.failed).toBe(true)
  })

  test('a single-item criteria tool rejects an array of items', async () => {
    const client = await connectTools(criteriaTools, untouchableDb())

    const version = await client.call('criteria_version_create', { items: [{ fromSetId: 1 }] })
    const update = await client.call('criteria_requirement_update', { requirementId: [1], patch: { weight: 1 } })

    expect([version.failed, update.failed]).toEqual([true, true])
  })

  test('criteria_requirement_add adds a requirement after the existing ones and returns it as stored', async () => {
    const client = await connectTools(criteriaTools, database())
    const { setId } = await arranged('Grown')

    const added = await client.call('criteria_requirement_add', {
      criteriaSetId: setId,
      key: 'focus',
      label: 'Focus',
      anchors: { '0': 'none', '0.5': 'partly', '1': 'fully' },
    })
    const rubric = await client.call('criteria_requirements', { criteriaSetId: setId })

    expect(added.failed).toBe(false)
    expect(added.body).toMatchObject({ key: 'focus', label: 'Focus', kind: 'soft', weight: null, layerLabel: null, detours: [] })
    expect((rubric.body as Req[]).map((row) => row.key)).toEqual(['skill', 'focus'])
  })

  test('criteria_requirement_add takes a kind and a weight when given', async () => {
    const client = await connectTools(criteriaTools, database())
    const { setId } = await arranged('Gated')

    const added = await client.call('criteria_requirement_add', {
      criteriaSetId: setId,
      key: 'remote',
      label: 'Remote',
      kind: 'gate',
      weight: 2,
      anchors: { '0': 'office', '0.5': 'hybrid', '1': 'remote' },
    })

    expect(added.body).toMatchObject({ key: 'remote', kind: 'gate', weight: 2 })
  })

  test('criteria_requirement_add refuses a key the set already has, an unknown set and an archived set', async () => {
    const client = await connectTools(criteriaTools, database())
    const { setId } = await arranged('Guarded')
    const retired = await arranged('Guarded retired')
    await archiveCriteriaSetForTest(database(), retired.setId)
    const anchors = { '0': 'a', '0.5': 'b', '1': 'c' }

    const duplicate = await client.call('criteria_requirement_add', { criteriaSetId: setId, key: 'skill', label: 'Again', anchors })
    const missing = await client.call('criteria_requirement_add', { criteriaSetId: 999_999, key: 'x', label: 'X', anchors })
    const archived = await client.call('criteria_requirement_add', { criteriaSetId: retired.setId, key: 'x', label: 'X', anchors })

    expect([duplicate.failed, missing.failed, archived.failed]).toEqual([true, true, true])
    expect(failureText(duplicate)).toContain('ConflictError')
    expect(failureText(missing)).toContain('criteria set 999999 does not exist')
    expect(failureText(archived)).toContain('ArchivedError')
  })

  test('criteria_requirement_add refuses missing anchors, a negative weight and an unknown field before touching the database', async () => {
    const client = await connectTools(criteriaTools, untouchableDb())

    const noAnchors = await client.call('criteria_requirement_add', { criteriaSetId: 1, key: 'x', label: 'X' })
    const negative = await client.call('criteria_requirement_add', {
      criteriaSetId: 1,
      key: 'x',
      label: 'X',
      weight: -1,
      anchors: { '0': 'a', '0.5': 'b', '1': 'c' },
    })
    const extra = await client.call('criteria_requirement_add', {
      criteriaSetId: 1,
      key: 'x',
      label: 'X',
      anchors: { '0': 'a', '0.5': 'b', '1': 'c' },
      importance: 3,
    })

    expect([noAnchors.failed, negative.failed, extra.failed]).toEqual([true, true, true])
  })
})
