import { describe, expect, test } from 'bun:test'

import { addRegistryRows, archiveRegistryRow } from '../../../src/data/repositories/registries.ts'
import { BULK_MAX } from '../../../src/schemas/common.ts'
import { postingTools } from '../../../src/mcp/tools/postings.ts'
import { connectTools, failureText, idOf, untouchableDb, useSharedScratchDatabase } from './harness.ts'

const database = useSharedScratchDatabase()

/** The ids a tool returned, read off its JSON body. */
function idsOf(body: unknown): number[] {
  return (body as { id: number }[]).map((row) => row.id)
}

describe('the postings group', () => {
  test('the postings group registers exactly the named tools', () => {
    expect(postingTools.map((tool) => tool.name).sort()).toEqual([
      'posting_add',
      'posting_add_bulk',
      'posting_get',
      'posting_search',
      'posting_update',
      'posting_update_bulk',
    ])
  })

  test('no tool sets annotations, which are left for the author to decide', () => {
    expect(postingTools.filter((tool) => tool.annotations !== undefined)).toEqual([])
  })

  test('posting_add records one posting and returns it as stored', async () => {
    const client = await connectTools(postingTools, database())

    const outcome = await client.call('posting_add', { company: { name: 'Single Co' }, roleTitle: 'Engineer' })

    expect(outcome.failed).toBe(false)
    expect(outcome.body).toMatchObject({ id: expect.any(Number), roleTitle: 'Engineer' })
  })

  test('posting_add rejects an input missing roleTitle before touching the database', async () => {
    const client = await connectTools(postingTools, untouchableDb())

    const outcome = await client.call('posting_add', { company: { name: 'No Title Co' } })

    expect(outcome.failed).toBe(true)
    expect(failureText(outcome)).toContain('roleTitle')
  })

  test('posting_add rejects an array, because the single form takes one item', async () => {
    const client = await connectTools(postingTools, untouchableDb())

    const outcome = await client.call('posting_add', {
      items: [{ company: { name: 'Array Co' }, roleTitle: 'Engineer' }],
    })

    expect(outcome.failed).toBe(true)
  })

  test('posting_add names the real cause of a failure and not the bulk item that carried it', async () => {
    const client = await connectTools(postingTools, database())

    const outcome = await client.call('posting_add', {
      company: { name: 'Bad Route Co' },
      roleTitle: 'Engineer',
      applyRouteId: 999_999,
    })

    expect(outcome.failed).toBe(true)
    expect(failureText(outcome)).toContain('apply_route 999999 does not exist')
    expect(failureText(outcome)).not.toContain('bulk item')
  })

  test('posting_add_bulk writes three postings and returns their ids', async () => {
    const client = await connectTools(postingTools, database())

    const outcome = await client.call('posting_add_bulk', {
      items: ['One', 'Two', 'Three'].map((title) => ({ company: { name: 'Bulk Co' }, roleTitle: title })),
    })

    expect(outcome.failed).toBe(false)
    expect(idsOf(outcome.body)).toHaveLength(3)
    expect(new Set(idsOf(outcome.body)).size).toBe(3)
  })

  test('posting_add_bulk names the failing item by index and rolls the call back', async () => {
    const client = await connectTools(postingTools, database())

    const outcome = await client.call('posting_add_bulk', {
      items: [
        { company: { name: 'Rollback Co' }, roleTitle: 'First' },
        { company: { name: 'Rollback Co' }, roleTitle: 'Second', applyRouteId: 999_999 },
      ],
    })
    const search = await client.call('posting_search', { limit: 200 })

    expect(outcome.failed).toBe(true)
    expect(failureText(outcome)).toContain('bulk item 1 failed')
    expect(failureText(outcome)).toContain('apply_route 999999 does not exist')
    expect(JSON.stringify(search.body)).not.toContain('Rollback Co')
  })

  test('posting_add_bulk rejects an over-cap array and an empty one at the schema', async () => {
    const client = await connectTools(postingTools, untouchableDb())
    const item = { company: { name: 'Cap Co' }, roleTitle: 'Engineer' }

    const over = await client.call('posting_add_bulk', { items: Array.from({ length: BULK_MAX + 1 }, () => item) })
    const empty = await client.call('posting_add_bulk', { items: [] })

    expect([over.failed, empty.failed]).toEqual([true, true])
  })

  test('posting_add_bulk rejects a single item, because the bulk form takes an array', async () => {
    const client = await connectTools(postingTools, untouchableDb())

    const outcome = await client.call('posting_add_bulk', { company: { name: 'Lone Co' }, roleTitle: 'Engineer' })

    expect(outcome.failed).toBe(true)
  })

  test('posting_add refuses priorityRank, which only an update may set', async () => {
    const client = await connectTools(postingTools, untouchableDb())

    const outcome = await client.call('posting_add', {
      company: { name: 'Rank Co' },
      roleTitle: 'Engineer',
      priorityRank: 1,
    })

    expect(outcome.failed).toBe(true)
  })

  test('posting_get returns the detail of one posting and a missing id is a not-found error', async () => {
    const client = await connectTools(postingTools, database())
    const added = await client.call('posting_add', { company: { name: 'Detail Co' }, roleTitle: 'Engineer' })
    const id = (added.body as { id: number }).id

    const found = await client.call('posting_get', { postingId: id })
    const missing = await client.call('posting_get', { postingId: 999_999 })

    expect(found.body).toMatchObject({ posting: { id }, company: { name: 'Detail Co' }, scores: [] })
    expect(missing.failed).toBe(true)
    expect(failureText(missing)).toContain('posting 999999 does not exist')
  })

  test('posting_search filters by company and pages through the list, newest first', async () => {
    const client = await connectTools(postingTools, database())
    await client.call('posting_add_bulk', {
      items: [
        { company: { name: 'Search Co' }, roleTitle: 'Alpha', seenAt: '2026-02-01' },
        { company: { name: 'Search Co' }, roleTitle: 'Beta', seenAt: '2026-03-01' },
        { company: { name: 'Search Co' }, roleTitle: 'Gamma', seenAt: '2026-01-01' },
        { company: { name: 'Elsewhere Co' }, roleTitle: 'Delta', seenAt: '2026-04-01' },
      ],
    })
    const companyId = ((await client.call('posting_search', { limit: 200 })).body as {
      company: { id: number; name: string }
    }[]).find((row) => row.company.name === 'Search Co')?.company.id

    const all = await client.call('posting_search', { companyId })
    const page = await client.call('posting_search', { companyId, limit: 1, offset: 1 })

    const titles = (rows: unknown) => (rows as { posting: { roleTitle: string } }[]).map((row) => row.posting.roleTitle)
    expect(titles(all.body)).toEqual(['Beta', 'Alpha', 'Gamma'])
    expect(titles(page.body)).toEqual(['Alpha'])
  })

  test('posting_search accepts filters beside pagination and refuses a key it does not name', async () => {
    const client = await connectTools(postingTools, database())

    const accepted = await client.call('posting_search', { limit: 5, offset: 0, setAside: 'include', recommendApply: true })
    const refused = await client.call('posting_search', { limit: 5, colour: 'red' })

    expect(accepted.failed).toBe(false)
    expect(refused.failed).toBe(true)
  })

  test('posting_update changes the named fields and leaves the rest', async () => {
    const client = await connectTools(postingTools, database())
    const added = await client.call('posting_add', { company: { name: 'Update Co' }, roleTitle: 'Engineer', country: 'PT' })
    const id = (added.body as { id: number }).id

    const updated = await client.call('posting_update', { postingId: id, patch: { city: 'Porto', priorityRank: 2 } })

    expect(updated.body).toMatchObject({ id, city: 'Porto', priorityRank: 2, country: 'PT', roleTitle: 'Engineer' })
  })

  test('posting_update rejects an empty patch and an unknown id is a not-found error', async () => {
    const client = await connectTools(postingTools, database())

    const empty = await client.call('posting_update', { postingId: 1, patch: {} })
    const missing = await client.call('posting_update', { postingId: 999_999, patch: { city: 'Porto' } })

    expect(empty.failed).toBe(true)
    expect(failureText(missing)).toContain('posting 999999 does not exist')
  })

  test('posting_update refuses a route row that is archived, naming the registry row', async () => {
    const client = await connectTools(postingTools, database())
    const added = await client.call('posting_add', { company: { name: 'Archived Route Co' }, roleTitle: 'Engineer' })
    const id = (added.body as { id: number }).id
    const routeId = idOf(await addRegistryRows(database(), 'apply_route', [{ label: 'Retired route' }]))
    await archiveRegistryRow(database(), 'apply_route', routeId)

    const outcome = await client.call('posting_update', { postingId: id, patch: { applyRouteId: routeId } })

    expect(failureText(outcome)).toContain(`apply_route ${routeId} is archived`)
  })

  test('posting_update_bulk patches several postings and returns them in the order given', async () => {
    const client = await connectTools(postingTools, database())
    const added = await client.call('posting_add_bulk', {
      items: ['A', 'B', 'C'].map((title) => ({ company: { name: 'Bulk Update Co' }, roleTitle: title })),
    })
    const ids = idsOf(added.body)

    const outcome = await client.call('posting_update_bulk', {
      items: [ids[2], ids[0]].map((postingId, index) => ({ postingId, patch: { city: `City ${index}` } })),
    })

    expect(outcome.failed).toBe(false)
    expect(outcome.body).toEqual([
      expect.objectContaining({ id: ids[2], city: 'City 0' }),
      expect.objectContaining({ id: ids[0], city: 'City 1' }),
    ])
  })

  test('posting_update_bulk names the failing item by index and leaves every earlier item unchanged', async () => {
    const client = await connectTools(postingTools, database())
    const added = await client.call('posting_add', { company: { name: 'Bulk Rollback Co' }, roleTitle: 'Engineer' })
    const id = (added.body as { id: number }).id

    const outcome = await client.call('posting_update_bulk', {
      items: [
        { postingId: id, patch: { city: 'Lisbon' } },
        { postingId: 999_999, patch: { city: 'Nowhere' } },
      ],
    })
    const after = await client.call('posting_get', { postingId: id })

    expect(failureText(outcome)).toContain('bulk item 1 failed: posting 999999 does not exist')
    expect(after.body).toMatchObject({ posting: { id, city: null } })
  })

  test('posting_update_bulk rejects an over-cap array, an empty one, a single item and an empty patch at the schema', async () => {
    const client = await connectTools(postingTools, untouchableDb())
    const item = { postingId: 1, patch: { city: 'Porto' } }

    const over = await client.call('posting_update_bulk', { items: Array.from({ length: BULK_MAX + 1 }, () => item) })
    const empty = await client.call('posting_update_bulk', { items: [] })
    const single = await client.call('posting_update_bulk', item)
    const emptyPatch = await client.call('posting_update_bulk', { items: [{ postingId: 1, patch: {} }] })

    expect([over.failed, empty.failed, single.failed, emptyPatch.failed]).toEqual([true, true, true, true])
  })
})
