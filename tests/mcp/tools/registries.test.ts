import { describe, expect, test } from 'bun:test'

import { BULK_MAX } from '../../../src/schemas/common.ts'
import { REGISTRY_NAMES, REGISTRY_SCHEMAS } from '../../../src/schemas/registries.ts'
import { registryTools } from '../../../src/mcp/tools/registries.ts'
import { connectTools, failureText, untouchableDb, useSharedScratchDatabase } from './harness.ts'

const database = useSharedScratchDatabase()

type Row = { id: number; label: string; archivedAt: string | null }

describe('the registries group', () => {
  test('the registries group registers exactly the named tools', () => {
    expect(registryTools.map((tool) => tool.name).sort()).toEqual([
      'registry_add',
      'registry_add_bulk',
      'registry_archive',
      'registry_list',
    ])
  })

  test('no tool sets annotations, which are left for the author to decide', () => {
    expect(registryTools.filter((tool) => tool.annotations !== undefined)).toEqual([])
  })

  test('the names a tool accepts are exactly the registries the schemas cover', () => {
    const listed: string[] = [...REGISTRY_NAMES]

    expect(listed.sort()).toEqual(Object.keys(REGISTRY_SCHEMAS).sort())
  })

  test('registry_add stores one row and registry_list returns it', async () => {
    const client = await connectTools(registryTools, database())

    const added = await client.call('registry_add', { registry: 'route', row: { label: 'Referral' } })
    const listed = await client.call('registry_list', { registry: 'route' })

    expect(added.body).toMatchObject({ id: expect.any(Number), label: 'Referral' })
    expect(listed.body).toEqual(expect.arrayContaining([added.body]))
  })

  test('registry_add refuses an unknown registry name at the schema', async () => {
    const client = await connectTools(registryTools, untouchableDb())

    const outcome = await client.call('registry_add', { registry: 'colour', row: { label: 'Red' } })

    expect(outcome.failed).toBe(true)
  })

  test('registry_add refuses a row that does not fit its registry, in both directions', async () => {
    const client = await connectTools(registryTools, untouchableDb())

    const phaseWithoutKey = await client.call('registry_add', { registry: 'phase', row: { label: 'Board' } })
    const routeWithSort = await client.call('registry_add', { registry: 'route', row: { label: 'Cold', sort: 1 } })

    expect([phaseWithoutKey.failed, routeWithSort.failed]).toEqual([true, true])
  })

  test('registry_add rejects an array, because the single form takes one row', async () => {
    const client = await connectTools(registryTools, untouchableDb())

    const outcome = await client.call('registry_add', { registry: 'route', row: [{ label: 'A' }] })

    expect(outcome.failed).toBe(true)
  })

  test('registry_add and registry_add_bulk refuse a NUL in a label or a key before touching the database', async () => {
    const client = await connectTools(registryTools, untouchableDb())

    const label = await client.call('registry_add', { registry: 'route', row: { label: 'Cold\u0000call' } })
    const key = await client.call('registry_add', { registry: 'phase', row: { key: 'p\u00001', label: 'Board' } })
    const bulk = await client.call('registry_add_bulk', { registry: 'route', items: [{ label: 'Fine' }, { label: 'a\u0000b' }] })

    expect([label.failed, key.failed, bulk.failed]).toEqual([true, true, true])
    expect([failureText(label), failureText(key), failureText(bulk)].map((text) => text.includes('NUL'))).toEqual([true, true, true])
  })

  test('registry_add_bulk stores several rows of one registry and keeps their order', async () => {
    const client = await connectTools(registryTools, database())

    const added = await client.call('registry_add_bulk', {
      registry: 'work_format',
      items: [{ label: 'Remote' }, { label: 'Hybrid' }, { label: 'On site' }],
    })

    expect((added.body as Row[]).map((row) => row.label)).toEqual(['Remote', 'Hybrid', 'On site'])
  })

  test('registry_add_bulk rejects an over-cap array, an empty one and a single row at the schema', async () => {
    const client = await connectTools(registryTools, untouchableDb())

    const over = await client.call('registry_add_bulk', {
      registry: 'route',
      items: Array.from({ length: BULK_MAX + 1 }, (_, index) => ({ label: `Route ${index}` })),
    })
    const empty = await client.call('registry_add_bulk', { registry: 'route', items: [] })
    const single = await client.call('registry_add_bulk', { registry: 'route', row: { label: 'Lone' } })

    expect([over.failed, empty.failed, single.failed]).toEqual([true, true, true])
  })

  test('a duplicate key is a conflict that names the key', async () => {
    const client = await connectTools(registryTools, database())
    await client.call('registry_add', { registry: 'phase', row: { key: 'dup', label: 'First' } })

    const second = await client.call('registry_add', { registry: 'phase', row: { key: 'dup', label: 'Second' } })

    expect(second.failed).toBe(true)
    expect(failureText(second)).toContain('phase key dup already exists')
  })

  test('a stage may name the phase it belongs to, and the phase flag round-trips', async () => {
    const client = await connectTools(registryTools, database())
    const phase = (await client.call('registry_add', {
      registry: 'phase',
      row: { key: 'short', label: 'Shortlist', isShortlist: true },
    })).body as { id: number }

    const stage = await client.call('registry_add', {
      registry: 'stage',
      row: { key: 'queued', label: 'Queued', phaseId: phase.id, isApplied: false },
    })

    expect(phase).toMatchObject({ isShortlist: true })
    expect(stage.body).toMatchObject({ key: 'queued', phaseId: phase.id })
  })

  test('registry_archive hides a row from the default list and keeps it in the full one', async () => {
    const client = await connectTools(registryTools, database())
    const row = (await client.call('registry_add', { registry: 'rejection_reason', row: { label: 'Too far' } }))
      .body as Row

    const archived = await client.call('registry_archive', { registry: 'rejection_reason', id: row.id })
    const visible = await client.call('registry_list', { registry: 'rejection_reason' })
    const everything = await client.call('registry_list', { registry: 'rejection_reason', includeArchived: true })

    expect((archived.body as Row).archivedAt).not.toBeNull()
    expect((visible.body as Row[]).map((r) => r.id)).not.toContain(row.id)
    expect((everything.body as Row[]).map((r) => r.id)).toContain(row.id)
  })

  test('registry_archive on an already archived row is a no-op, not an error', async () => {
    const client = await connectTools(registryTools, database())
    const row = (await client.call('registry_add', { registry: 'text_type', row: { label: 'Letter' } })).body as Row
    const first = await client.call('registry_archive', { registry: 'text_type', id: row.id })

    const again = await client.call('registry_archive', { registry: 'text_type', id: row.id })

    expect(again.failed).toBe(false)
    expect(again.body).toEqual(first.body)
  })

  test('registry_archive on an unknown id is a not-found error naming the registry', async () => {
    const client = await connectTools(registryTools, database())

    const outcome = await client.call('registry_archive', { registry: 'layer', id: 999_999 })

    expect(outcome.failed).toBe(true)
    expect(failureText(outcome)).toContain('layer 999999 does not exist')
  })

  test('registry_list refuses an unknown registry name at the schema', async () => {
    const client = await connectTools(registryTools, untouchableDb())

    const outcome = await client.call('registry_list', { registry: 'colour' })

    expect(outcome.failed).toBe(true)
  })
})
