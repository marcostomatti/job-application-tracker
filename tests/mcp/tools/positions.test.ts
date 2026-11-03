import { describe, expect, test } from 'bun:test'

import { addRegistryRows, archiveRegistryRow } from '../../../src/data/repositories/registries.ts'
import { BULK_MAX } from '../../../src/schemas/common.ts'
import { positionTools } from '../../../src/mcp/tools/positions.ts'
import { connectTools, failureText, idOf, untouchableDb, useSharedScratchDatabase } from './harness.ts'

const database = useSharedScratchDatabase()

/** The ids a tool returned, read off its JSON body. */
function idsOf(body: unknown): number[] {
  return (body as { id: number }[]).map((row) => row.id)
}

describe('the positions group', () => {
  test('the positions group registers exactly the named tools', () => {
    expect(positionTools.map((tool) => tool.name).sort()).toEqual([
      'position_add',
      'position_add_bulk',
      'position_get',
      'position_search',
      'position_update',
    ])
  })

  test('no tool sets annotations, which are left for the author to decide', () => {
    expect(positionTools.filter((tool) => tool.annotations !== undefined)).toEqual([])
  })

  test('position_add records one position and returns it as stored', async () => {
    const client = await connectTools(positionTools, database())

    const outcome = await client.call('position_add', { company: { name: 'Single Co' }, roleTitle: 'Engineer' })

    expect(outcome.failed).toBe(false)
    expect(outcome.body).toMatchObject({ id: expect.any(Number), roleTitle: 'Engineer' })
  })

  test('position_add rejects an input missing roleTitle before touching the database', async () => {
    const client = await connectTools(positionTools, untouchableDb())

    const outcome = await client.call('position_add', { company: { name: 'No Title Co' } })

    expect(outcome.failed).toBe(true)
    expect(failureText(outcome)).toContain('roleTitle')
  })

  test('position_add rejects an array, because the single form takes one item', async () => {
    const client = await connectTools(positionTools, untouchableDb())

    const outcome = await client.call('position_add', {
      items: [{ company: { name: 'Array Co' }, roleTitle: 'Engineer' }],
    })

    expect(outcome.failed).toBe(true)
  })

  test('position_add names the real cause of a failure and not the bulk item that carried it', async () => {
    const client = await connectTools(positionTools, database())

    const outcome = await client.call('position_add', {
      company: { name: 'Bad Route Co' },
      roleTitle: 'Engineer',
      applyRouteId: 999_999,
    })

    expect(outcome.failed).toBe(true)
    expect(failureText(outcome)).toContain('apply_route 999999 does not exist')
    expect(failureText(outcome)).not.toContain('bulk item')
  })

  test('position_add_bulk writes three positions and returns their ids', async () => {
    const client = await connectTools(positionTools, database())

    const outcome = await client.call('position_add_bulk', {
      items: ['One', 'Two', 'Three'].map((title) => ({ company: { name: 'Bulk Co' }, roleTitle: title })),
    })

    expect(outcome.failed).toBe(false)
    expect(idsOf(outcome.body)).toHaveLength(3)
    expect(new Set(idsOf(outcome.body)).size).toBe(3)
  })

  test('position_add_bulk names the failing item by index and rolls the call back', async () => {
    const client = await connectTools(positionTools, database())

    const outcome = await client.call('position_add_bulk', {
      items: [
        { company: { name: 'Rollback Co' }, roleTitle: 'First' },
        { company: { name: 'Rollback Co' }, roleTitle: 'Second', applyRouteId: 999_999 },
      ],
    })
    const search = await client.call('position_search', { limit: 200 })

    expect(outcome.failed).toBe(true)
    expect(failureText(outcome)).toContain('bulk item 1 failed')
    expect(failureText(outcome)).toContain('apply_route 999999 does not exist')
    expect(JSON.stringify(search.body)).not.toContain('Rollback Co')
  })

  test('position_add_bulk rejects an over-cap array and an empty one at the schema', async () => {
    const client = await connectTools(positionTools, untouchableDb())
    const item = { company: { name: 'Cap Co' }, roleTitle: 'Engineer' }

    const over = await client.call('position_add_bulk', { items: Array.from({ length: BULK_MAX + 1 }, () => item) })
    const empty = await client.call('position_add_bulk', { items: [] })

    expect([over.failed, empty.failed]).toEqual([true, true])
  })

  test('position_add_bulk rejects a single item, because the bulk form takes an array', async () => {
    const client = await connectTools(positionTools, untouchableDb())

    const outcome = await client.call('position_add_bulk', { company: { name: 'Lone Co' }, roleTitle: 'Engineer' })

    expect(outcome.failed).toBe(true)
  })

  test('position_add refuses priorityRank, which only an update may set', async () => {
    const client = await connectTools(positionTools, untouchableDb())

    const outcome = await client.call('position_add', {
      company: { name: 'Rank Co' },
      roleTitle: 'Engineer',
      priorityRank: 1,
    })

    expect(outcome.failed).toBe(true)
  })

  test('position_get returns the detail of one position and a missing id is a not-found error', async () => {
    const client = await connectTools(positionTools, database())
    const added = await client.call('position_add', { company: { name: 'Detail Co' }, roleTitle: 'Engineer' })
    const id = (added.body as { id: number }).id

    const found = await client.call('position_get', { positionId: id })
    const missing = await client.call('position_get', { positionId: 999_999 })

    expect(found.body).toMatchObject({ position: { id }, company: { name: 'Detail Co' }, scores: [] })
    expect(missing.failed).toBe(true)
    expect(failureText(missing)).toContain('position 999999 does not exist')
  })

  test('position_search filters by company and pages through the list, newest first', async () => {
    const client = await connectTools(positionTools, database())
    await client.call('position_add_bulk', {
      items: [
        { company: { name: 'Search Co' }, roleTitle: 'Alpha', seenAt: '2026-02-01' },
        { company: { name: 'Search Co' }, roleTitle: 'Beta', seenAt: '2026-03-01' },
        { company: { name: 'Search Co' }, roleTitle: 'Gamma', seenAt: '2026-01-01' },
        { company: { name: 'Elsewhere Co' }, roleTitle: 'Delta', seenAt: '2026-04-01' },
      ],
    })
    const companyId = ((await client.call('position_search', { limit: 200 })).body as {
      company: { id: number; name: string }
    }[]).find((row) => row.company.name === 'Search Co')?.company.id

    const all = await client.call('position_search', { companyId })
    const page = await client.call('position_search', { companyId, limit: 1, offset: 1 })

    const titles = (rows: unknown) => (rows as { position: { roleTitle: string } }[]).map((row) => row.position.roleTitle)
    expect(titles(all.body)).toEqual(['Beta', 'Alpha', 'Gamma'])
    expect(titles(page.body)).toEqual(['Alpha'])
  })

  test('position_search accepts filters beside pagination and refuses a key it does not name', async () => {
    const client = await connectTools(positionTools, database())

    const accepted = await client.call('position_search', { limit: 5, offset: 0, setAside: 'include', recommendApply: true })
    const refused = await client.call('position_search', { limit: 5, colour: 'red' })

    expect(accepted.failed).toBe(false)
    expect(refused.failed).toBe(true)
  })

  test('position_update changes the named fields and leaves the rest', async () => {
    const client = await connectTools(positionTools, database())
    const added = await client.call('position_add', { company: { name: 'Update Co' }, roleTitle: 'Engineer', country: 'PT' })
    const id = (added.body as { id: number }).id

    const updated = await client.call('position_update', { positionId: id, patch: { city: 'Porto', priorityRank: 2 } })

    expect(updated.body).toMatchObject({ id, city: 'Porto', priorityRank: 2, country: 'PT', roleTitle: 'Engineer' })
  })

  test('position_update rejects an empty patch and an unknown id is a not-found error', async () => {
    const client = await connectTools(positionTools, database())

    const empty = await client.call('position_update', { positionId: 1, patch: {} })
    const missing = await client.call('position_update', { positionId: 999_999, patch: { city: 'Porto' } })

    expect(empty.failed).toBe(true)
    expect(failureText(missing)).toContain('position 999999 does not exist')
  })

  test('position_update refuses a route row that is archived, naming the registry row', async () => {
    const client = await connectTools(positionTools, database())
    const added = await client.call('position_add', { company: { name: 'Archived Route Co' }, roleTitle: 'Engineer' })
    const id = (added.body as { id: number }).id
    const routeId = idOf(await addRegistryRows(database(), 'apply_route', [{ label: 'Retired route' }]))
    await archiveRegistryRow(database(), 'apply_route', routeId)

    const outcome = await client.call('position_update', { positionId: id, patch: { applyRouteId: routeId } })

    expect(failureText(outcome)).toContain(`apply_route ${routeId} is archived`)
  })
})
