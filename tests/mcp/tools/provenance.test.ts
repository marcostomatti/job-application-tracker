import { describe, expect, test } from 'bun:test'

import { appendStageEvent } from '../../../src/data/repositories/dispositions.ts'
import { addPostings } from '../../../src/data/repositories/postings.ts'
import { addRegistryRows, archiveRegistryRow } from '../../../src/data/repositories/registries.ts'
import { writeSummary } from '../../../src/data/repositories/summaries.ts'
import { provenanceTools } from '../../../src/mcp/tools/provenance.ts'
import { BULK_MAX } from '../../../src/schemas/common.ts'
import { connectTools, failureText, idOf, untouchableDb, useSharedScratchDatabase } from './harness.ts'

const database = useSharedScratchDatabase()

type Touch = { id: number; postingId: number | null; touchedOn: string; note: string | null }

async function newPostingId(title: string): Promise<number> {
  return idOf(await addPostings(database(), [{ company: { name: `${title} Co` }, roleTitle: title }]))
}

async function newRouteId(label: string): Promise<number> {
  return idOf(await addRegistryRows(database(), 'route', [{ label }]))
}

describe('the origins group', () => {
  test('the provenance module registers exactly the named tools', () => {
    expect(provenanceTools.map((tool) => tool.name).sort()).toEqual([
      'check_already_applied',
      'check_posting_changed',
      'check_reposted',
      'origin_attach',
      'origin_first_touch',
      'origin_list',
      'origin_record',
      'origin_record_bulk',
      'route_counts',
      'search_run_record',
    ])
  })

  test('no tool sets annotations, which are left for the author to decide', () => {
    expect(provenanceTools.filter((tool) => tool.annotations !== undefined)).toEqual([])
  })

  test('origin_record logs a touch with no posting and no route, which is a real state of a fresh install', async () => {
    const client = await connectTools(provenanceTools, database())

    const outcome = await client.call('origin_record', { touchedOn: '2026-03-01', note: 'Met at a meetup' })

    expect(outcome.failed).toBe(false)
    expect(outcome.body).toMatchObject({ postingId: null, routeId: null, touchedOn: '2026-03-01', note: 'Met at a meetup' })
  })

  test('origin_record refuses an archived route, an unknown posting and an unknown search run', async () => {
    const client = await connectTools(provenanceTools, database())
    const routeId = await newRouteId('Retired board')
    await archiveRegistryRow(database(), 'route', routeId)

    const archived = await client.call('origin_record', { touchedOn: '2026-03-01', routeId })
    const noPosting = await client.call('origin_record', { touchedOn: '2026-03-01', postingId: 999_999 })
    const noRun = await client.call('origin_record', { touchedOn: '2026-03-01', searchRunId: 999_999 })

    expect(failureText(archived)).toContain(`route ${routeId} is archived`)
    expect(failureText(noPosting)).toContain('posting 999999 does not exist')
    expect(failureText(noRun)).toContain('search run 999999 does not exist')
  })

  test('origin_record refuses a NUL byte in the note, a bad date and an array before touching the database', async () => {
    const client = await connectTools(provenanceTools, untouchableDb())

    const nul = await client.call('origin_record', { touchedOn: '2026-03-01', note: 'a\u0000b' })
    const badDate = await client.call('origin_record', { touchedOn: 'yesterday' })
    const array = await client.call('origin_record', { items: [{ touchedOn: '2026-03-01' }] })

    expect([nul.failed, badDate.failed, array.failed]).toEqual([true, true, true])
  })

  test('origin_record_bulk logs several touches in the order given', async () => {
    const client = await connectTools(provenanceTools, database())
    const postingId = await newPostingId('Bulk touches')

    const outcome = await client.call('origin_record_bulk', {
      items: [
        { postingId, touchedOn: '2026-03-02', note: 'second day' },
        { postingId, touchedOn: '2026-03-01', note: 'first day' },
      ],
    })

    expect(outcome.body).toEqual([
      expect.objectContaining({ postingId, note: 'second day' }),
      expect.objectContaining({ postingId, note: 'first day' }),
    ])
  })

  test('origin_record_bulk names the failing item by index and keeps none of the batch', async () => {
    const client = await connectTools(provenanceTools, database())
    const postingId = await newPostingId('Bulk touches rollback')

    const outcome = await client.call('origin_record_bulk', {
      items: [
        { postingId, touchedOn: '2026-03-01', note: 'must not survive' },
        { postingId: 999_999, touchedOn: '2026-03-01' },
      ],
    })
    const listed = await client.call('origin_list', { postingId })

    expect(failureText(outcome)).toContain('bulk item 1 failed: posting 999999 does not exist')
    expect(listed.body).toEqual([])
  })

  test('origin_record_bulk rejects an over-cap array, an empty one and a single item at the schema', async () => {
    const client = await connectTools(provenanceTools, untouchableDb())
    const item = { touchedOn: '2026-03-01' }

    const over = await client.call('origin_record_bulk', { items: Array.from({ length: BULK_MAX + 1 }, () => item) })
    const empty = await client.call('origin_record_bulk', { items: [] })
    const single = await client.call('origin_record_bulk', item)

    expect([over.failed, empty.failed, single.failed]).toEqual([true, true, true])
  })

  test('origin_attach ties a loose touch to a posting, and repeating it changes nothing', async () => {
    const client = await connectTools(provenanceTools, database())
    const postingId = await newPostingId('Attached')
    const loose = await client.call('origin_record', { touchedOn: '2026-02-01', note: 'Loose touch' })
    const originId = (loose.body as Touch).id

    const first = await client.call('origin_attach', { originId, postingId })
    const again = await client.call('origin_attach', { originId, postingId })
    const listed = await client.call('origin_list', { postingId })

    expect(first.body).toMatchObject({ id: originId, postingId, touchedOn: '2026-02-01' })
    expect(again.body).toEqual(first.body)
    expect((listed.body as Touch[]).map((touch) => touch.id)).toEqual([originId])
  })

  test('origin_attach refuses a touch already on another posting and an unknown touch', async () => {
    const client = await connectTools(provenanceTools, database())
    const owner = await newPostingId('Attach owner')
    const other = await newPostingId('Attach other')
    const recorded = await client.call('origin_record', { postingId: owner, touchedOn: '2026-02-01' })
    const originId = (recorded.body as Touch).id

    const moved = await client.call('origin_attach', { originId, postingId: other })
    const missing = await client.call('origin_attach', { originId: 999_999, postingId: owner })

    expect(failureText(moved)).toContain(`origin ${originId} is already attached to another posting`)
    expect(failureText(missing)).toContain('origin 999999 does not exist')
  })

  test('origin_list returns a posting\'s touches earliest first, and not-found for no posting', async () => {
    const client = await connectTools(provenanceTools, database())
    const postingId = await newPostingId('Listed')
    await client.call('origin_record', { postingId, touchedOn: '2026-05-02', note: 'later' })
    await client.call('origin_record', { postingId, touchedOn: '2026-05-01', note: 'earlier' })

    const listed = await client.call('origin_list', { postingId })
    const missing = await client.call('origin_list', { postingId: 999_999 })

    expect((listed.body as Touch[]).map((touch) => touch.note)).toEqual(['earlier', 'later'])
    expect(failureText(missing)).toContain('posting 999999 does not exist')
  })

  test('origin_first_touch returns the backdated conversation, not the first-recorded row', async () => {
    const client = await connectTools(provenanceTools, database())
    const postingId = await newPostingId('Backdated touch')
    const board = await newRouteId('Job board for first touch')
    await client.call('origin_record', { postingId, routeId: board, touchedOn: '2026-05-01', note: 'Saw the posting' })
    await client.call('origin_record', { postingId, touchedOn: '2026-04-01', note: 'Talked at a meetup' })

    const first = await client.call('origin_first_touch', { postingId })

    expect(first.body).toMatchObject({ postingId, touchedOn: '2026-04-01', note: 'Talked at a meetup', routeId: null })
  })

  test('origin_first_touch is null for a posting with no touch, and not-found for no posting', async () => {
    const client = await connectTools(provenanceTools, database())
    const postingId = await newPostingId('Untouched')

    const none = await client.call('origin_first_touch', { postingId })
    const missing = await client.call('origin_first_touch', { postingId: 999_999 })

    expect(none).toEqual({ failed: false, body: null })
    expect(failureText(missing)).toContain('posting 999999 does not exist')
  })

  test('route_counts counts the postings each route reached, once each, and names the route label', async () => {
    const client = await connectTools(provenanceTools, database())
    const board = await newRouteId('Counted board')
    const friend = await newRouteId('Counted friend')
    const first = await newPostingId('Counted one')
    const second = await newPostingId('Counted two')
    await client.call('origin_record_bulk', {
      items: [
        { postingId: first, routeId: board, touchedOn: '2026-01-01' },
        { postingId: first, routeId: board, touchedOn: '2026-01-02' },
        { postingId: second, routeId: board, touchedOn: '2026-01-03' },
        { postingId: second, routeId: friend, touchedOn: '2026-01-04' },
      ],
    })
    await archiveRegistryRow(database(), 'route', friend)

    const outcome = await client.call('route_counts', {})

    expect(outcome.body).toContainEqual({ routeId: board, routeLabel: 'Counted board', postings: 2 })
    expect(outcome.body).toContainEqual({ routeId: friend, routeLabel: 'Counted friend', postings: 1 })
    const counts = (outcome.body as Array<{ routeId: number | null; postings: number }>).map((row) => row.postings)
    expect(counts).toEqual([...counts].sort((left, right) => right - left))
    const routeIds = (outcome.body as Array<{ routeId: number | null }>).map((row) => row.routeId)
    expect(routeIds.indexOf(board)).toBeLessThan(routeIds.indexOf(friend))
  })

  test('origin_first_touch ignores a future-dated touch, which origin_list still shows', async () => {
    const client = await connectTools(provenanceTools, database())
    const postingId = await newPostingId('Future dated')
    await client.call('origin_record', { postingId, touchedOn: '2099-01-01', note: 'Mistyped year' })

    const first = await client.call('origin_first_touch', { postingId })
    const listed = await client.call('origin_list', { postingId })

    expect(first).toEqual({ failed: false, body: null })
    expect((listed.body as Touch[]).map((touch) => touch.note)).toEqual(['Mistyped year'])
  })

  test('route_counts takes no arguments and refuses one', async () => {
    const client = await connectTools(provenanceTools, untouchableDb())

    const outcome = await client.call('route_counts', { routeId: 1 })

    expect(outcome.failed).toBe(true)
  })
})

describe('the search runs and checks group', () => {
  test('search_run_record stores what was asked and where, and an origin can then name the run', async () => {
    const client = await connectTools(provenanceTools, database())

    const run = await client.call('search_run_record', { query: 'typescript remote', source: 'a job board' })
    const searchRunId = (run.body as { id: number }).id
    const touch = await client.call('origin_record', { touchedOn: '2026-03-01', searchRunId })

    expect(run.body).toMatchObject({ query: 'typescript remote', source: 'a job board' })
    expect(touch.body).toMatchObject({ searchRunId })
  })

  test('search_run_record refuses a blank query, a NUL byte and an unknown field before touching the database', async () => {
    const client = await connectTools(provenanceTools, untouchableDb())

    const blank = await client.call('search_run_record', { query: '  ', source: 'x' })
    const nul = await client.call('search_run_record', { query: 'a\u0000b', source: 'x' })
    const extra = await client.call('search_run_record', { query: 'a', source: 'x', ranAt: '2026-01-01' })

    expect([blank.failed, nul.failed, extra.failed]).toEqual([true, true, true])
  })

  test('check_already_applied is false for a posting with no stage event', async () => {
    const client = await connectTools(provenanceTools, database())
    const postingId = await newPostingId('Never staged')

    const outcome = await client.call('check_already_applied', { postingId })

    expect(outcome).toEqual({ failed: false, body: false })
  })

  test('check_already_applied follows the latest stage: null and unflagged read false, a flagged stage reads true', async () => {
    const client = await connectTools(provenanceTools, database())
    const postingId = await newPostingId('Applied flow')
    const unflagged = idOf(await addRegistryRows(database(), 'stage', [{ key: 'check-unflagged', label: 'Unflagged' }]))
    const flagged = idOf(await addRegistryRows(database(), 'stage', [{ key: 'check-flagged', label: 'Flagged', isApplied: true }]))
    const state = async (): Promise<unknown> => (await client.call('check_already_applied', { postingId })).body
    await appendStageEvent(database(), { postingId, stageId: null, occurredAt: new Date('2026-06-01T10:00:00Z') })
    const afterNull = await state()
    await appendStageEvent(database(), { postingId, stageId: unflagged, occurredAt: new Date('2026-06-02T10:00:00Z') })
    const afterUnflagged = await state()
    await appendStageEvent(database(), { postingId, stageId: flagged, occurredAt: new Date('2026-06-03T10:00:00Z') })
    const afterFlagged = await state()
    await appendStageEvent(database(), { postingId, stageId: unflagged, occurredAt: new Date('2026-06-04T10:00:00Z') })
    const afterMovedOn = await state()

    expect([afterNull, afterUnflagged, afterFlagged, afterMovedOn]).toEqual([false, false, true, false])
  })

  test('check_already_applied is not-found for no posting, since false would be an answer about nothing', async () => {
    const client = await connectTools(provenanceTools, database())

    const outcome = await client.call('check_already_applied', { postingId: 999_999 })

    expect(outcome.failed).toBe(true)
    expect(failureText(outcome)).toContain('posting 999999 does not exist')
  })

  test('check_posting_changed is true with no summary, false for the stored hash and true after the hash changes', async () => {
    const client = await connectTools(provenanceTools, database())
    const postingId = await newPostingId('Posting hash')
    const changed = async (sourceHash: string): Promise<unknown> =>
      (await client.call('check_posting_changed', { postingId, sourceHash })).body

    const beforeSummary = await changed('hash-1')
    await writeSummary(database(), { postingId, condensed: 'Builds a tracker.', sourceHash: 'hash-1' })
    const sameHash = await changed('hash-1')
    const newHash = await changed('hash-2')

    expect([beforeSummary, sameHash, newHash]).toEqual([true, false, true])
  })

  test('check_posting_changed refuses an empty hash before touching the database, and not-found for no posting', async () => {
    const refusing = await connectTools(provenanceTools, untouchableDb())
    const client = await connectTools(provenanceTools, database())

    const empty = await refusing.call('check_posting_changed', { postingId: 1, sourceHash: '  ' })
    const missing = await client.call('check_posting_changed', { postingId: 999_999, sourceHash: 'h' })

    expect(empty.failed).toBe(true)
    expect(failureText(missing)).toContain('posting 999999 does not exist')
  })

  test('check_reposted is false for one origin and true once the role came round again', async () => {
    const client = await connectTools(provenanceTools, database())
    const postingId = await newPostingId('Reposted')
    const reposted = async (): Promise<unknown> => (await client.call('check_reposted', { postingId })).body

    const none = await reposted()
    await client.call('origin_record', { postingId, touchedOn: '2026-01-01' })
    const once = await reposted()
    await client.call('origin_record', { postingId, touchedOn: '2026-02-01' })
    const twice = await reposted()
    const missing = await client.call('check_reposted', { postingId: 999_999 })

    expect([none, once, twice]).toEqual([false, false, true])
    expect(failureText(missing)).toContain('posting 999999 does not exist')
  })

  test('each check description names the other two checks, so a model can tell them apart', () => {
    const checks = ['check_already_applied', 'check_posting_changed', 'check_reposted']

    for (const name of checks) {
      const description = provenanceTools.find((tool) => tool.name === name)?.description ?? ''
      for (const neighbour of checks.filter((other) => other !== name)) {
        expect(description).toContain(neighbour)
      }
    }
  })
})
