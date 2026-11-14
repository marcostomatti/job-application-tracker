import { describe, expect, test } from 'bun:test'
import postgres from 'postgres'

import { addRegistryRows } from '../../../src/data/repositories/registries.ts'
import { addPostings } from '../../../src/data/repositories/postings.ts'
import { addText } from '../../../src/data/repositories/texts.ts'
import { textTools } from '../../../src/mcp/tools/texts.ts'
import { BULK_MAX } from '../../../src/schemas/common.ts'
import { waitUntilABackendWaitsOnALock } from '../../data/lock-wait.ts'
import { withMigratedScratchDatabase } from '../../data/scratch-database.ts'
import { connectTools, failureText, idOf, untouchableDb, useSharedScratchDatabase } from './harness.ts'

const database = useSharedScratchDatabase()

type Listed = { label: string; version: number; body: string; textTypeId: number | null }

describe('the texts group', () => {
  test('the texts group registers exactly the named tools', () => {
    expect(textTools.map((tool) => tool.name).sort()).toEqual([
      'text_add',
      'text_add_bulk',
      'text_link',
      'text_link_bulk',
      'text_list',
      'text_update',
    ])
  })

  test('no tool sets annotations, which are left for the author to decide', () => {
    expect(textTools.filter((tool) => tool.annotations !== undefined)).toEqual([])
  })

  test('text_add stores version 1 with its type and text_list reads it back', async () => {
    const client = await connectTools(textTools, database())
    const textTypeId = idOf(await addRegistryRows(database(), 'text_type', [{ label: 'Outreach added' }]))

    const added = await client.call('text_add', { label: 'Warm intro', body: 'Hello\n  there', textTypeId })
    const listed = await client.call('text_list', { textTypeId })

    expect(added.failed).toBe(false)
    expect(added.body).toMatchObject({ label: 'Warm intro', version: 1, body: 'Hello\n  there', textTypeId })
    expect((listed.body as Listed[]).map((text) => text.label)).toEqual(['Warm intro'])
  })

  test('text_add refuses a label that already names a text and says so', async () => {
    const client = await connectTools(textTools, database())
    await client.call('text_add', { label: 'Taken label', body: 'first' })

    const again = await client.call('text_add', { label: 'Taken label', body: 'second' })

    expect(again.failed).toBe(true)
    expect(failureText(again)).toContain('text label Taken label already exists')
  })

  test('text_add refuses a NUL byte in the body, a blank body and an array before touching the database', async () => {
    const client = await connectTools(textTools, untouchableDb())

    const nul = await client.call('text_add', { label: 'x', body: 'pasted\u0000text' })
    const blank = await client.call('text_add', { label: 'x', body: '   ' })
    const array = await client.call('text_add', { items: [{ label: 'x', body: 'y' }] })

    expect([nul.failed, blank.failed, array.failed]).toEqual([true, true, true])
    expect(failureText(nul)).toContain('NUL')
  })

  test('text_add_bulk adds several texts and returns them in the order given', async () => {
    const client = await connectTools(textTools, database())

    const outcome = await client.call('text_add_bulk', {
      items: [
        { label: 'Bulk b', body: 'two' },
        { label: 'Bulk a', body: 'one' },
      ],
    })

    expect(outcome.body).toEqual([
      expect.objectContaining({ label: 'Bulk b', version: 1 }),
      expect.objectContaining({ label: 'Bulk a', version: 1 }),
    ])
  })

  test('text_add_bulk names the failing item by index and keeps none of the batch', async () => {
    const client = await connectTools(textTools, database())
    await client.call('text_add', { label: 'Bulk existing', body: 'already here' })

    const outcome = await client.call('text_add_bulk', {
      items: [
        { label: 'Bulk rolled back', body: 'must not survive' },
        { label: 'Bulk existing', body: 'collides' },
      ],
    })
    const listed = await client.call('text_list', {})

    expect(outcome.failed).toBe(true)
    expect(failureText(outcome)).toContain('bulk item 1 failed: text label Bulk existing already exists')
    expect((listed.body as Listed[]).map((text) => text.label)).not.toContain('Bulk rolled back')
  })

  test('text_add_bulk rejects an over-cap array, an empty one and a single item at the schema', async () => {
    const client = await connectTools(textTools, untouchableDb())
    const item = { label: 'x', body: 'y' }

    const over = await client.call('text_add_bulk', { items: Array.from({ length: BULK_MAX + 1 }, () => item) })
    const empty = await client.call('text_add_bulk', { items: [] })
    const single = await client.call('text_add_bulk', item)

    expect([over.failed, empty.failed, single.failed]).toEqual([true, true, true])
  })

  test('text_update writes a new version, and text_list shows the newest by default and every version on request', async () => {
    const client = await connectTools(textTools, database())
    await client.call('text_add', { label: 'Versioned', body: 'First wording' })

    const updated = await client.call('text_update', { label: 'Versioned', body: 'Second wording' })
    const newest = await client.call('text_list', {})
    const history = await client.call('text_list', { includeHistory: true })
    const versionsOf = (body: unknown): Array<[number, string]> =>
      (body as Listed[]).filter((text) => text.label === 'Versioned').map((text) => [text.version, text.body])

    expect(updated.body).toMatchObject({ label: 'Versioned', version: 2, body: 'Second wording' })
    expect(versionsOf(newest.body)).toEqual([[2, 'Second wording']])
    expect(versionsOf(history.body)).toEqual([[2, 'Second wording'], [1, 'First wording']])
  })

  test('text_update of a label no text has is a not-found error', async () => {
    const client = await connectTools(textTools, database())

    const outcome = await client.call('text_update', { label: 'Never added', body: 'x' })

    expect(outcome.failed).toBe(true)
    expect(failureText(outcome)).toContain('text Never added does not exist')
  })

  test('text_update does not accept a version, which the data layer numbers', async () => {
    const client = await connectTools(textTools, untouchableDb())

    const outcome = await client.call('text_update', { label: 'x', body: 'y', version: 7 })

    expect(outcome.failed).toBe(true)
  })

  test('text_list refuses an option it does not know', async () => {
    const client = await connectTools(textTools, untouchableDb())

    const outcome = await client.call('text_list', { label: 'x' })

    expect(outcome.failed).toBe(true)
  })

  test('text_update that loses a race to another writer reports a conflict and writes nothing twice', async () => {
    const { outcome, versions } = await withMigratedScratchDatabase(async (db, sql) => {
      const url = new URL(process.env.DATABASE_URL ?? '')
      url.pathname = `/${sql.options.database}`
      const writer = postgres(url.toString(), { max: 1, onnotice: () => {} })
      const observer = postgres(url.toString(), { max: 1, onnotice: () => {} })
      try {
        await addText(db, { label: 'Cover', body: 'first' })
        const client = await connectTools(textTools, db)
        let attempt: ReturnType<typeof client.call> | undefined
        await writer.begin(async (transaction) => {
          await transaction`insert into text_asset (label, body, version) values ('Cover', 'from the writer', 2)`
          attempt = client.call('text_update', { label: 'Cover', body: 'from the loser' })
          await waitUntilABackendWaitsOnALock(observer)
        })
        const settled = await attempt
        const rows = await observer`select version, body from text_asset where label = 'Cover' order by version, id`
        return { outcome: settled, versions: rows.map((row) => [row.version, row.body]) }
      } finally {
        await writer.end()
        await observer.end()
      }
    })

    expect(outcome?.failed).toBe(true)
    expect(failureText(outcome as NonNullable<typeof outcome>)).toContain('ConflictError')
    expect(failureText(outcome as NonNullable<typeof outcome>)).toContain('was changed by another write')
    expect(versions).toEqual([[1, 'first'], [2, 'from the writer']])
  })
})

describe('the text links', () => {
  test('text_link links a version and text_list with postingId reads exactly that version back', async () => {
    const client = await connectTools(textTools, database())
    const postingId = idOf(await addPostings(database(), [{ company: { name: 'Link tool Co' }, roleTitle: 'Link tool role' }]))
    const sent = await addText(database(), { label: 'Link tool letter', body: 'as sent' })
    await client.call('text_update', { label: 'Link tool letter', body: 'edited later' })

    const linked = await client.call('text_link', { textAssetId: sent.id, postingId })
    const listed = await client.call('text_list', { postingId })

    expect(linked.body).toMatchObject({ textAssetId: sent.id, postingId })
    expect((listed.body as Listed[]).map((row) => [row.version, row.body])).toEqual([[1, 'as sent']])
  })

  test('text_link_bulk links nothing when an item names an unknown posting, and names its index', async () => {
    const client = await connectTools(textTools, database())
    const postingId = idOf(await addPostings(database(), [{ company: { name: 'Link bulk Co' }, roleTitle: 'Link bulk role' }]))
    const text = await addText(database(), { label: 'Link bulk letter', body: 'hello' })

    const outcome = await client.call('text_link_bulk', {
      items: [
        { textAssetId: text.id, postingId },
        { textAssetId: text.id, postingId: 999_999 },
      ],
    })
    const listed = await client.call('text_list', { postingId })

    expect(outcome.failed).toBe(true)
    expect(failureText(outcome)).toContain('1')
    expect(listed.body).toEqual([])
  })

  test('text_link refuses a label in place of a version id before touching the database', async () => {
    const client = await connectTools(textTools, untouchableDb())

    const outcome = await client.call('text_link', { label: 'Some letter', postingId: 1 })

    expect(outcome.failed).toBe(true)
  })
})
