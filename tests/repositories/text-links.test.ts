import { describe, expect, test } from 'bun:test'

import { addPostings } from '../../src/data/repositories/postings.ts'
import { addRegistryRows } from '../../src/data/repositories/registries.ts'
import { addText, linkText, listTexts, updateText } from '../../src/data/repositories/texts.ts'
import { NotFoundError } from '../../src/errors.ts'
import { TextLinkInputSchema, TextQuerySchema } from '../../src/schemas/texts.ts'
import { thrownBy } from '../data/rolled-back.ts'
import { idOf, useSharedScratchDatabase } from '../mcp/tools/harness.ts'

const database = useSharedScratchDatabase()

async function newPostingId(title: string): Promise<number> {
  return idOf(await addPostings(database(), [{ company: { name: `${title} Co` }, roleTitle: title }]))
}

describe('linkText', () => {
  test('links one version of a text to a posting and returns the link', async () => {
    // Arrange
    const postingId = await newPostingId('Linked letter')
    const text = await addText(database(), { label: 'Link letter one', body: 'Dear team' })

    // Act
    const link = await linkText(database(), { textAssetId: text.id, postingId })

    // Assert
    expect(link).toMatchObject({ textAssetId: text.id, postingId })
    expect(link.linkedAt).toBeInstanceOf(Date)
  })

  test('linking twice is a no-op that returns the first link', async () => {
    // Arrange
    const postingId = await newPostingId('Linked twice')
    const text = await addText(database(), { label: 'Link letter twice', body: 'Hello' })
    const first = await linkText(database(), { textAssetId: text.id, postingId })

    // Act
    const again = await linkText(database(), { textAssetId: text.id, postingId })

    // Assert
    expect(again).toEqual(first)
    expect(await listTexts(database(), { postingId })).toHaveLength(1)
  })

  test('an unknown text or an unknown posting is a not-found error', async () => {
    // Arrange
    const postingId = await newPostingId('Linked to nothing')
    const text = await addText(database(), { label: 'Link letter orphan', body: 'Hi' })

    // Act
    const noText = await thrownBy(() => linkText(database(), { textAssetId: 999_999, postingId }))
    const noPosting = await thrownBy(() => linkText(database(), { textAssetId: text.id, postingId: 999_999 }))

    // Assert
    expect(noText).toBeInstanceOf(NotFoundError)
    expect(noPosting).toBeInstanceOf(NotFoundError)
  })
})

describe('listTexts by posting', () => {
  test('lists exactly the versions linked to the posting, even after the text has a newer version', async () => {
    // Arrange
    const postingId = await newPostingId('Sent letter')
    const otherId = await newPostingId('Other letter')
    const sent = await addText(database(), { label: 'Link letter sent', body: 'Version one' })
    await updateText(database(), { label: 'Link letter sent', body: 'Version two' })
    const other = await addText(database(), { label: 'Link letter other', body: 'Unrelated' })
    await linkText(database(), { textAssetId: sent.id, postingId })
    await linkText(database(), { textAssetId: other.id, postingId: otherId })

    // Act
    const linked = await listTexts(database(), { postingId })
    const withHistory = await listTexts(database(), { postingId, includeHistory: true })

    // Assert
    expect(linked.map((row) => [row.label, row.version, row.body])).toEqual([['Link letter sent', 1, 'Version one']])
    expect(withHistory).toEqual(linked)
  })

  test('keeps only the linked labels whose newest version has the type asked for', async () => {
    // Arrange
    const postingId = await newPostingId('Typed letters')
    const letterType = idOf(await addRegistryRows(database(), 'text_type', [{ label: 'Link test letter' }]))
    const typed = await addText(database(), { label: 'Link typed', body: 'A', textTypeId: letterType })
    const untyped = await addText(database(), { label: 'Link untyped', body: 'B' })
    await linkText(database(), { textAssetId: typed.id, postingId })
    await linkText(database(), { textAssetId: untyped.id, postingId })

    // Act
    const listed = await listTexts(database(), { postingId, textTypeId: letterType })

    // Assert
    expect(listed.map((row) => row.label)).toEqual(['Link typed'])
  })

  test('an unknown posting is a not-found error, and a posting with no links is an empty list', async () => {
    // Arrange
    const postingId = await newPostingId('Unlinked')

    // Act
    const error = await thrownBy(() => listTexts(database(), { postingId: 999_999 }))

    // Assert
    expect(error).toBeInstanceOf(NotFoundError)
    expect(await listTexts(database(), { postingId })).toEqual([])
  })
})

describe('the link schemas', () => {
  test('a link names a text version and a posting, and a query may name a posting', () => {
    // Assert
    expect(TextLinkInputSchema.safeParse({ textAssetId: 1, postingId: 2 }).success).toBe(true)
    expect(TextLinkInputSchema.safeParse({ label: 'x', postingId: 2 }).success).toBe(false)
    expect(TextQuerySchema.parse({ postingId: '4' })).toEqual({ postingId: 4 })
  })
})
