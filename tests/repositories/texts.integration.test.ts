import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { count } from 'drizzle-orm'
import postgres from 'postgres'

import { lintMigrations } from '../../drizzle/lint/migration-lint'
import type { DrizzleClient } from '../../src/data/client.ts'
import { addRegistryRows, archiveRegistryRow } from '../../src/data/repositories/registries.ts'
import { addText, listTexts, updateText } from '../../src/data/repositories/texts.ts'
import { textAsset } from '../../src/data/schema/texts.ts'
import { ArchivedError, ConflictError, NotFoundError, statusFor } from '../../src/errors.ts'
import { NewTextBulkSchema, NewTextSchema, TextQuerySchema, TextUpdateSchema } from '../../src/schemas/texts.ts'
import { waitUntilABackendWaitsOnALock } from '../data/lock-wait.ts'
import { thrownBy } from '../data/rolled-back.ts'
import { withMigratedScratchDatabase } from '../data/scratch-database.ts'

const MIGRATIONS_DIR = join(import.meta.dir, '..', '..', 'drizzle')

function idOf(rows: readonly { readonly id: number }[], index = 0): number {
  const id = rows[index]?.id
  if (id === undefined) throw new Error(`the arrangement produced no row at index ${index}`)
  return id
}

async function addTextType(db: DrizzleClient, label: string): Promise<number> {
  return idOf(await addRegistryRows(db, 'text_type', [{ label }]))
}

describe('the unique index on (label, version)', () => {
  test('is added by a migration that passes the lint', () => {
    // Arrange
    const names = readdirSync(MIGRATIONS_DIR).filter((name) => /^0011_.*\.sql$/.test(name))
    expect(names).toHaveLength(1)
    const migration = join(MIGRATIONS_DIR, names[0] as string)

    // Act
    const sqlText = readFileSync(migration, 'utf8')
    const findings = lintMigrations(MIGRATIONS_DIR).filter((finding) => finding.file === migration)

    // Assert
    expect(sqlText).toMatch(/CREATE UNIQUE INDEX "text_asset_label_version_unique"/)
    expect(sqlText.match(/\bTABLE\b/g) ?? []).toEqual([])
    expect(findings).toEqual([])
  })
})

describe('addText', () => {
  test('stores version 1 with the given type, and a repeated label is a ConflictError', async () => {
    await withMigratedScratchDatabase(async (db) => {
      // Arrange
      const typeId = await addTextType(db, 'outreach')

      // Act
      const stored = await addText(db, { label: 'Warm intro', body: 'Hello', textTypeId: typeId })
      const typeless = await addText(db, { label: 'Plain', body: 'Hi' })
      const duplicate = await thrownBy(() => addText(db, { label: 'Warm intro', body: 'Other' }))

      // Assert
      expect(stored.version).toBe(1)
      expect(stored.textTypeId).toBe(typeId)
      expect(typeless.textTypeId).toBeNull()
      expect(duplicate).toBeInstanceOf(ConflictError)
      expect(statusFor(duplicate)).toBe(409)
      expect((duplicate as Error).message).not.toMatch(/insert|duplicate key/i)
      expect((duplicate as Error).cause).toBeDefined()
    })
  })

  test('refuses an archived or unknown text type', async () => {
    await withMigratedScratchDatabase(async (db) => {
      const typeId = await addTextType(db, 'old')
      await archiveRegistryRow(db, 'text_type', typeId)

      expect(await thrownBy(() => addText(db, { label: 'a', body: 'b', textTypeId: typeId }))).toBeInstanceOf(ArchivedError)
      expect(await thrownBy(() => addText(db, { label: 'a', body: 'b', textTypeId: 9999 }))).toBeInstanceOf(NotFoundError)
      expect((await db.select({ total: count() }).from(textAsset))[0]?.total).toBe(0)
    })
  })
})

describe('updateText', () => {
  test('writes a new version and leaves the old body readable', async () => {
    await withMigratedScratchDatabase(async (db) => {
      // Arrange
      const typeId = await addTextType(db, 'letter')
      await addText(db, { label: 'Cover', body: 'First wording', textTypeId: typeId })

      // Act
      const second = await updateText(db, { label: 'Cover', body: 'Second wording' })
      const third = await updateText(db, { label: 'Cover', body: 'Third wording' })
      const history = await listTexts(db, { includeHistory: true })

      // Assert
      expect([second.version, third.version]).toEqual([2, 3])
      expect(second.textTypeId).toBe(typeId)
      expect(history.map((row) => [row.version, row.body])).toEqual([
        [3, 'Third wording'],
        [2, 'Second wording'],
        [1, 'First wording'],
      ])
    })
  })

  test('changes the type when one is given, clears it with null, and keeps it when absent', async () => {
    await withMigratedScratchDatabase(async (db) => {
      const first = await addTextType(db, 'one')
      const second = await addTextType(db, 'two')
      await addText(db, { label: 'Cover', body: 'a', textTypeId: first })

      const moved = await updateText(db, { label: 'Cover', body: 'b', textTypeId: second })
      const kept = await updateText(db, { label: 'Cover', body: 'c' })
      const cleared = await updateText(db, { label: 'Cover', body: 'd', textTypeId: null })

      expect([moved.textTypeId, kept.textTypeId, cleared.textTypeId]).toEqual([second, second, null])
    })
  })

  test('refuses a label that has no text, and an archived or unknown type it is asked to move to', async () => {
    await withMigratedScratchDatabase(async (db) => {
      const typeId = await addTextType(db, 'old')
      await addText(db, { label: 'Cover', body: 'a' })
      await archiveRegistryRow(db, 'text_type', typeId)

      expect(await thrownBy(() => updateText(db, { label: 'Missing', body: 'x' }))).toBeInstanceOf(NotFoundError)
      expect(await thrownBy(() => updateText(db, { label: 'Cover', body: 'x', textTypeId: typeId }))).toBeInstanceOf(ArchivedError)
      expect(await thrownBy(() => updateText(db, { label: 'Cover', body: 'x', textTypeId: 9999 }))).toBeInstanceOf(NotFoundError)
      expect((await db.select({ total: count() }).from(textAsset))[0]?.total).toBe(1)
    })
  })

  test('keeps a type archived after the text was written, because only a newly named type is checked', async () => {
    await withMigratedScratchDatabase(async (db) => {
      const typeId = await addTextType(db, 'later archived')
      await addText(db, { label: 'Cover', body: 'a', textTypeId: typeId })
      await archiveRegistryRow(db, 'text_type', typeId)

      const next = await updateText(db, { label: 'Cover', body: 'b' })

      expect(next.textTypeId).toBe(typeId)
    })
  })

  test('writes only the columns the allow-list names, even when the object carries more', async () => {
    await withMigratedScratchDatabase(async (db) => {
      await addText(db, { label: 'Cover', body: 'a' })
      const sneaky = { label: 'Cover', body: 'b', version: 40, id: 999, createdAt: new Date('2001-01-01T00:00:00Z') }

      const next = await updateText(db, sneaky)

      expect(next.version).toBe(2)
      expect(next.id).not.toBe(999)
      expect(next.createdAt.getUTCFullYear()).toBeGreaterThan(2020)
    })
  })

  test('a writer holding the next version loses the race to the index as a ConflictError, and nothing is doubled', async () => {
    // Arrange / Act: another connection inserts version 2 and keeps it open, so the max read cannot see it
    const { error, versions } = await withMigratedScratchDatabase(async (db, sql) => {
      const url = new URL(process.env.DATABASE_URL ?? '')
      url.pathname = `/${sql.options.database}`
      const writer = postgres(url.toString(), { max: 1, onnotice: () => {} })
      const observer = postgres(url.toString(), { max: 1, onnotice: () => {} })
      try {
        await addText(db, { label: 'Cover', body: 'first' })
        let attempt: Promise<unknown> = Promise.resolve()
        await writer.begin(async (transaction) => {
          await transaction`insert into text_asset (label, body, version) values ('Cover', 'from the writer', 2)`
          attempt = thrownBy(() => updateText(db, { label: 'Cover', body: 'from the loser' }))
          await waitUntilABackendWaitsOnALock(observer)
        })
        const error = await attempt
        const rows = await observer`select version, body from text_asset where label = 'Cover' order by version, id`
        return { error, versions: rows.map((row) => [row.version, row.body]) }
      } finally {
        await writer.end()
        await observer.end()
      }
    })

    // Assert
    expect(error).toBeInstanceOf(ConflictError)
    expect(statusFor(error)).toBe(409)
    expect((error as Error).message).not.toMatch(/insert|select|duplicate key/i)
    expect((error as Error).cause).toBeDefined()
    expect(versions).toEqual([[1, 'first'], [2, 'from the writer']])
  })

  test('two updates one after the other number 2 and 3', async () => {
    await withMigratedScratchDatabase(async (db) => {
      await addText(db, { label: 'Cover', body: 'a' })
      const [one, two] = [await updateText(db, { label: 'Cover', body: 'b' }), await updateText(db, { label: 'Cover', body: 'c' })]
      expect([one.version, two.version]).toEqual([2, 3])
    })
  })
})

describe('listTexts', () => {
  test('returns the latest version of each label, by label', async () => {
    await withMigratedScratchDatabase(async (db) => {
      await addText(db, { label: 'B letter', body: 'b1' })
      await addText(db, { label: 'A note', body: 'a1' })
      await updateText(db, { label: 'B letter', body: 'b2' })

      const latest = await listTexts(db)

      expect(latest.map((row) => [row.label, row.version, row.body])).toEqual([
        ['A note', 1, 'a1'],
        ['B letter', 2, 'b2'],
      ])
      expect(await listTexts(db, {})).toEqual(latest)
    })
  })

  test('is empty on a fresh install', async () => {
    await withMigratedScratchDatabase(async (db) => {
      expect(await listTexts(db)).toEqual([])
      expect(await listTexts(db, { includeHistory: true })).toEqual([])
    })
  })

  test('filters by the type of the latest version, and a label that left the type is no longer listed under it', async () => {
    await withMigratedScratchDatabase(async (db) => {
      // Arrange: Cover was a letter, then became outreach; Intro stayed a letter
      const letter = await addTextType(db, 'letter')
      const outreach = await addTextType(db, 'outreach')
      await addText(db, { label: 'Cover', body: 'c1', textTypeId: letter })
      await addText(db, { label: 'Intro', body: 'i1', textTypeId: letter })
      await updateText(db, { label: 'Cover', body: 'c2', textTypeId: outreach })

      // Act
      const letters = await listTexts(db, { textTypeId: letter })
      const outreaches = await listTexts(db, { textTypeId: outreach })
      const outreachHistory = await listTexts(db, { textTypeId: outreach, includeHistory: true })

      // Assert
      expect(letters.map((row) => row.label)).toEqual(['Intro'])
      expect(outreaches.map((row) => [row.label, row.version])).toEqual([['Cover', 2]])
      expect(outreachHistory.map((row) => [row.label, row.version])).toEqual([['Cover', 2], ['Cover', 1]])
    })
  })

  test('still lists a text whose type was archived afterwards', async () => {
    await withMigratedScratchDatabase(async (db) => {
      const typeId = await addTextType(db, 'letter')
      await addText(db, { label: 'Cover', body: 'a', textTypeId: typeId })
      await archiveRegistryRow(db, 'text_type', typeId)

      expect(await listTexts(db, { textTypeId: typeId })).toHaveLength(1)
    })
  })
})

describe('the text input schemas', () => {
  test('a new text needs a label and a body, refuses NUL in either, and refuses unknown keys', () => {
    expect(NewTextSchema.parse({ label: ' Cover ', body: 'Hello' })).toEqual({ label: 'Cover', body: 'Hello' })
    expect(NewTextSchema.safeParse({ label: 'Cover', body: 'a\u0000b' }).success).toBe(false)
    expect(NewTextSchema.safeParse({ label: 'a\u0000', body: 'b' }).success).toBe(false)
    expect(NewTextSchema.safeParse({ label: '', body: 'b' }).success).toBe(false)
    expect(NewTextSchema.safeParse({ label: 'a', body: '' }).success).toBe(false)
    expect(NewTextSchema.safeParse({ label: 'a', body: 'b', version: 3 }).success).toBe(false)
  })

  test('keeps the body as written: its own line breaks and indentation are the user\'s', () => {
    expect(NewTextSchema.parse({ label: 'a', body: '  Dear Sam,\n\n  Hello\n' }).body).toBe('  Dear Sam,\n\n  Hello\n')
  })

  test('an update names the label and the new body, and may name a type or clear it', () => {
    expect(TextUpdateSchema.parse({ label: 'a', body: 'b', textTypeId: '3' })).toEqual({ label: 'a', body: 'b', textTypeId: 3 })
    expect(TextUpdateSchema.parse({ label: 'a', body: 'b', textTypeId: null }).textTypeId).toBeNull()
    expect(TextUpdateSchema.safeParse({ body: 'b' }).success).toBe(false)
    expect(TextUpdateSchema.safeParse({ label: 'a', body: 'b', version: 2 }).success).toBe(false)
  })

  test('a query takes a type id and includeHistory as a boolean or its text form, and nothing else', () => {
    expect(TextQuerySchema.parse({})).toEqual({})
    expect(TextQuerySchema.parse({ textTypeId: '2', includeHistory: 'true' })).toEqual({ textTypeId: 2, includeHistory: true })
    expect(TextQuerySchema.safeParse({ includeHistory: 'yes' }).success).toBe(false)
    expect(TextQuerySchema.safeParse({ limit: 5 }).success).toBe(false)
  })

  test('the bulk form takes a bounded, non-empty list', () => {
    expect(NewTextBulkSchema.safeParse({ items: [] }).success).toBe(false)
    expect(NewTextBulkSchema.safeParse({ items: [{ label: 'a', body: 'b' }] }).success).toBe(true)
  })
})
