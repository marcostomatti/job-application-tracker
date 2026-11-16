import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'

import type { DrizzleClient } from '../../src/data/client.ts'
import { createCriteriaVersion, getRequirements, setDefaultCriteriaSet, updateRequirement } from '../../src/data/repositories/criteria.ts'
import { addPostings } from '../../src/data/repositories/postings.ts'
import { gateBlockedScoreIds } from '../../src/data/repositories/recommendations.ts'
import { addRegistryRows } from '../../src/data/repositories/registries.ts'
import { RULES_PASS_NOTE, runRulesPass } from '../../src/data/repositories/rules-pass.ts'
import { getScoreHistory, scorePosting } from '../../src/data/repositories/scores.ts'
import { insertCriteriaSet, requirement } from '../../src/data/schema/criteria.ts'
import { postingScore } from '../../src/data/schema/scores.ts'
import { NotFoundError } from '../../src/errors.ts'
import { thrownBy } from '../data/rolled-back.ts'
import { withMigratedScratchDatabase } from '../data/scratch-database.ts'

const ANCHORS = { '0': 'nothing', '0.5': 'some', '1': 'everything' }

type Arranged = { readonly setId: number; readonly titleGate: number; readonly placeGate: number; readonly soft: number }

/**
 * A default set with a title gate, a place gate and a soft requirement. The title gate blocks
 * one made-up term; the place gate allows country XA, or remote work anywhere.
 */
async function arrange(db: DrizzleClient): Promise<Arranged> {
  const set = await insertCriteriaSet(db, { name: 'Mine', applyThreshold: 0.6 })
  await setDefaultCriteriaSet(db, set.id)
  const rows = await db
    .insert(requirement)
    .values([
      { criteriaSetId: set.id, key: 'title_gate', label: 'Title gate', kind: 'gate', anchors: ANCHORS, sort: 0, rules: { titleBlocks: ['example framework'] } },
      { criteriaSetId: set.id, key: 'place_gate', label: 'Place gate', kind: 'gate', anchors: ANCHORS, sort: 1, rules: { place: [{ country: 'XA' }, { workFormat: 'Remote' }] } },
      { criteriaSetId: set.id, key: 'fit', label: 'Fit', kind: 'soft', weight: 1, anchors: ANCHORS, sort: 2 },
    ])
    .returning()
  const [titleGate, placeGate, soft] = rows.map((row) => row.id)
  if (titleGate === undefined || placeGate === undefined || soft === undefined) throw new Error('the arrangement stored no requirements')
  return { setId: set.id, titleGate, placeGate, soft }
}

let companies = 0

/** A posting at a company of its own, so two postings with one title are never the same role. */
async function addPosting(db: DrizzleClient, roleTitle: string, place: { country?: string; workFormatId?: number } = {}): Promise<number> {
  companies += 1
  const [added] = await addPostings(db, [{ company: { name: `Example ${companies} AB` }, roleTitle, ...place }])
  if (!added) throw new Error('the arrangement stored no posting')
  return added.id
}

describe('runRulesPass', () => {
  test('reports the blocked and the left without writing when write is false', async () => {
    await withMigratedScratchDatabase(async (db) => {
      // Arrange
      await arrange(db)
      const hybrid = idOfRow(await addRegistryRows(db, 'work_format', [{ label: 'Hybrid' }]))
      const byTitle = await addPosting(db, 'Example Framework Developer', { country: 'XA' })
      const byPlace = await addPosting(db, 'Backend Engineer', { country: 'XB', workFormatId: hybrid })
      const maybeRemote = await addPosting(db, 'Data Engineer', { country: 'XB' })
      const fine = await addPosting(db, 'Backend Engineer', { country: 'XA' })
      const open = await addPosting(db, 'Platform Engineer')

      // Act
      const result = await runRulesPass(db, { limit: 20, write: false })
      const scores = await db.select().from(postingScore)

      // Assert
      expect(result.blocked.map((item) => item.postingId)).toEqual([byTitle, byPlace])
      expect(result.blocked[0]?.findings.map((finding) => finding.requirementKey)).toEqual(['title_gate'])
      expect(result.blocked[1]?.findings[0]?.evidence).toBe('rules pass: country XB, work format Hybrid matches no allowed place')
      // No work format could still be remote, which one allowed place takes, so it stays open.
      expect(result.left.map((item) => item.postingId)).toEqual([maybeRemote, fine, open])
      expect(result).toMatchObject({ examined: 5, written: false, nextAfterPostingId: null })
      expect(scores).toEqual([])
    })
  })

  test('with write, stores a score for each blocked posting whose gate blocks it, and leaves the rest unscored', async () => {
    await withMigratedScratchDatabase(async (db) => {
      // Arrange
      const { setId, titleGate } = await arrange(db)
      const blocked = await addPosting(db, 'Example Framework Developer', { country: 'XA' })
      const left = await addPosting(db, 'Backend Engineer', { country: 'XA' })

      // Act
      await runRulesPass(db, { limit: 20, write: true })
      const [score] = await getScoreHistory(db, blocked)
      const again = await runRulesPass(db, { limit: 20, write: true })

      // Assert
      expect(score).toMatchObject({ criteriaSetId: setId, note: RULES_PASS_NOTE, recommendApply: false })
      expect(await gateBlockedScoreIds(db, [score?.id ?? 0])).toEqual(new Set([score?.id ?? 0]))
      expect(score?.limiterKey).toBe('title_gate')
      expect(await getScoreHistory(db, left)).toEqual([])
      expect(again.blocked).toEqual([])
      expect(again.left.map((item) => item.postingId)).toEqual([left])
      expect(titleGate).toBeGreaterThan(0)
    })
  })

  test('a remote posting outside the allowed country passes the place gate', async () => {
    await withMigratedScratchDatabase(async (db) => {
      await arrange(db)
      const remote = idOfRow(await addRegistryRows(db, 'work_format', [{ label: 'Remote' }]))
      const posting = await addPosting(db, 'Backend Engineer', { country: 'XB', workFormatId: remote })

      const result = await runRulesPass(db, { limit: 20, write: false })

      expect(result.left.map((item) => item.postingId)).toEqual([posting])
    })
  })

  test('skips postings already scored under the set, and walks the rest in batches by the cursor', async () => {
    await withMigratedScratchDatabase(async (db) => {
      // Arrange
      const { setId, soft } = await arrange(db)
      const ids = [await addPosting(db, 'One'), await addPosting(db, 'Two'), await addPosting(db, 'Three')]
      await scorePosting(db, { postingId: ids[0] ?? 0, criteriaSetId: setId, ratings: [{ requirementId: soft, coverage: 1, confidence: 'supported' }], penalties: [] })

      // Act
      const first = await runRulesPass(db, { limit: 1, write: false })
      const second = await runRulesPass(db, { limit: 1, write: false, afterPostingId: first.nextAfterPostingId ?? 0 })
      const end = await runRulesPass(db, { limit: 1, write: false, afterPostingId: second.nextAfterPostingId ?? 0 })

      // Assert
      expect(first.left.map((item) => item.postingId)).toEqual([ids[1] ?? 0])
      expect(second.left.map((item) => item.postingId)).toEqual([ids[2] ?? 0])
      expect(end).toMatchObject({ examined: 0, nextAfterPostingId: null })
    })
  })

  test('a set with no default and no id named is a NotFoundError', async () => {
    await withMigratedScratchDatabase(async (db) => {
      expect(await thrownBy(() => runRulesPass(db, { limit: 20, write: false }))).toBeInstanceOf(NotFoundError)
      expect(await thrownBy(() => runRulesPass(db, { criteriaSetId: 9999, limit: 20, write: false }))).toBeInstanceOf(NotFoundError)
    })
  })
})

describe('requirement rules', () => {
  test('are set and removed by updateRequirement, and a new version copies them', async () => {
    await withMigratedScratchDatabase(async (db) => {
      // Arrange
      const { setId, soft, titleGate } = await arrange(db)

      // Act
      const set = await updateRequirement(db, soft, { rules: { titleBlocks: ['a term'] } })
      const removed = await updateRequirement(db, titleGate, { rules: null })
      const copy = await createCriteriaVersion(db, { fromSetId: setId })
      const copied = await getRequirements(db, copy.id)
      const [stored] = await db.select({ rules: requirement.rules }).from(requirement).where(eq(requirement.id, soft))

      // Assert
      expect(set.rules).toEqual({ titleBlocks: ['a term'] })
      expect(removed.rules).toBeNull()
      expect(stored?.rules).toEqual({ titleBlocks: ['a term'] })
      expect(copied.find((row) => row.key === 'fit')?.rules).toEqual({ titleBlocks: ['a term'] })
      expect(copied.find((row) => row.key === 'place_gate')?.rules).toEqual({ place: [{ country: 'XA' }, { workFormat: 'Remote' }] })
    })
  })
})

function idOfRow(rows: readonly { readonly id: number }[]): number {
  const id = rows[0]?.id
  if (id === undefined) throw new Error('the arrangement produced no row')
  return id
}
