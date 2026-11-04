import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq, inArray } from 'drizzle-orm'

import { lintVanillaPacks } from '../../drizzle/lint/migration-lint'
import { closeDb } from '../../src/data/client.ts'
import {
  CriteriaSetConflictError,
  criteriaSet,
  insertCriteriaSet,
  requirement,
} from '../../src/data/schema/criteria.ts'
import { layer } from '../../src/data/schema/registries.ts'
import { VanillaPackSchema } from '../../src/schemas/scoring.ts'
import { scoreAgainstSet } from '../../src/scoring/score-against-set.ts'
import { PackCarriesJudgementError, loadPack, main } from '../../src/seeds/load-pack.ts'
import { rolledBack, thrownBy, type Tx } from '../data/rolled-back.ts'

const VANILLA_DIR = join(import.meta.dir, '..', '..', 'seeds', 'vanilla')
const SHIPPED_PACK = join(VANILLA_DIR, 'web-search.json')

type RawPack = {
  name: string
  version: number
  apply_threshold: unknown
  layers: { key: string; label: string }[]
  requirements: {
    key: string
    layer_key: string
    kind: string
    weight: unknown
    label: string
    anchors: Record<string, unknown>
  }[]
}

const readShipped = (): RawPack => JSON.parse(readFileSync(SHIPPED_PACK, 'utf8'))

let scratchDir = ''
beforeAll(() => {
  scratchDir = mkdtempSync(join(tmpdir(), 'pack-test-'))
})
afterAll(async () => {
  rmSync(scratchDir, { recursive: true, force: true })
  await closeDb()
})

/**
 * The shipped pack under a name unique to this call, for tests that load it on a database where
 * a user may already have run `seed:pack`. Its layers are the real ones; loadPack reuses a layer
 * that exists, so only the set name has to differ.
 */
function shippedAs(token: string): { file: string; pack: RawPack } {
  const pack = { ...readShipped(), name: `test-shipped-${token}` }
  return { file: writePack(token, pack), pack }
}

/** A copy of the shipped pack whose set name and layer keys are unique to this call. */
function uniquePack(token: string): RawPack {
  const base = readShipped()
  return {
    ...base,
    name: `test-pack-${token}`,
    layers: base.layers.map((entry) => ({ ...entry, key: `${entry.key}-${token}` })),
    requirements: base.requirements.map((entry) => ({
      ...entry,
      layer_key: `${entry.layer_key}-${token}`,
    })),
  }
}

function writePack(token: string, pack: unknown): string {
  const file = join(scratchDir, `${token}.json`)
  writeFileSync(file, JSON.stringify(pack, null, 2))
  return file
}

const withRequirement = (pack: RawPack, index: number, change: Record<string, unknown>): RawPack => ({
  ...pack,
  requirements: pack.requirements.map((entry, at) => (at === index ? { ...entry, ...change } : entry)),
})

async function layerKeysAmong(tx: Tx, keys: string[]): Promise<string[]> {
  const rows = await tx.select({ key: layer.key }).from(layer).where(inArray(layer.key, keys))
  return rows.map((row) => row.key)
}

describe('the shipped vanilla pack', () => {
  test('the shipped pack passes lintVanillaPacks', () => {
    // Arrange: an empty directory would pass the lint vacuously, so require the pack to be there
    expect(readdirSync(VANILLA_DIR)).toContain('web-search.json')

    // Act
    const findings = lintVanillaPacks(VANILLA_DIR)

    // Assert
    expect(findings).toEqual([])
  })

  test('the shipped pack has a null weight on every requirement', () => {
    // Arrange / Act
    const pack = readShipped()

    // Assert
    expect(pack.requirements.length).toBeGreaterThan(0)
    for (const entry of pack.requirements) expect(entry.weight).toBeNull()
  })

  test('the shipped pack has a null apply_threshold', () => {
    // Arrange / Act
    const pack = readShipped()

    // Assert: null, not absent, so the shipped file says outright that no bar is set
    expect(pack.apply_threshold).toBeNull()
  })

  test('the shipped pack satisfies VanillaPackSchema', () => {
    expect(VanillaPackSchema.safeParse(readShipped()).success).toBe(true)
  })

  test('the shipped pack declares no gate', () => {
    // Which requirement is a hard gate is the user's judgement, so a pack leaves every one soft.
    expect(readShipped().requirements.map((entry) => entry.kind)).not.toContain('gate')
  })
})

describe('VanillaPackSchema', () => {
  const anchorCases: [string, Record<string, unknown>][] = [
    ['empty anchors', {}],
    ['a missing 0.5', { '0': 'none', '1': 'all' }],
    ['a blank anchor', { '0': 'none', '0.5': '   ', '1': 'all' }],
    ['an extra key', { '0': 'none', '0.5': 'some', '1': 'all', '2': 'more' }],
  ]
  test.each(anchorCases)('rejects %s', (_label, anchors) => {
    const pack = withRequirement(readShipped(), 0, { anchors })

    expect(VanillaPackSchema.safeParse(pack).success).toBe(false)
  })

  test('rejects a weight and an apply_threshold on its own, without the lint', () => {
    const weighted = withRequirement(readShipped(), 0, { weight: 0.3 })
    const barred = { ...readShipped(), apply_threshold: 0.7 }

    expect(VanillaPackSchema.safeParse(weighted).success).toBe(false)
    expect(VanillaPackSchema.safeParse(barred).success).toBe(false)
  })

  test('rejects a requirement naming a layer the pack does not declare', () => {
    const pack = withRequirement(readShipped(), 0, { layer_key: 'undeclared' })

    expect(VanillaPackSchema.safeParse(pack).success).toBe(false)
  })

  test('rejects a key the schema does not know, so judgement cannot ride along unread', () => {
    const pack = withRequirement(readShipped(), 0, { importance: 5 })

    expect(VanillaPackSchema.safeParse(pack).success).toBe(false)
  })
})

describe('loadPack', () => {
  test('loadPack inserts the set, its requirements and the layers it names', async () => {
    // Arrange / Act
    const { result, set, rows, layers, pack } = await rolledBack(async (tx, token) => {
      const { file, pack } = shippedAs(token)
      const loaded = await loadPack(file, tx)
      const [stored] = await tx.select().from(criteriaSet).where(eq(criteriaSet.id, loaded.criteriaSetId))
      const stored_rows = await tx
        .select({ key: requirement.key, weight: requirement.weight, anchors: requirement.anchors, sort: requirement.sort, layerKey: layer.key })
        .from(requirement)
        .leftJoin(layer, eq(requirement.layerId, layer.id))
        .where(eq(requirement.criteriaSetId, loaded.criteriaSetId))
      return {
        result: loaded,
        set: stored,
        rows: stored_rows,
        layers: await layerKeysAmong(tx, pack.layers.map((entry) => entry.key)),
        pack,
      }
    })

    // Assert
    expect(result.requirementCount).toBe(pack.requirements.length)
    expect(set?.name).toBe(pack.name)
    expect(set?.version).toBe(pack.version)
    expect(set?.applyThreshold).toBeNull()
    // Not the default: see loadPack. A vanilla set cannot score anything yet.
    expect(set?.isDefault).toBe(false)
    expect(set?.archivedAt).toBeNull()
    expect(layers.sort()).toEqual(pack.layers.map((entry) => entry.key).sort())
    expect(rows.length).toBe(pack.requirements.length)
    for (const [index, entry] of pack.requirements.entries()) {
      const stored = rows.find((row) => row.key === entry.key)
      expect(stored?.layerKey).toBe(entry.layer_key)
      expect(stored?.weight).toBeNull()
      expect(stored?.anchors).toEqual(entry.anchors)
      expect(stored?.sort).toBe(index)
    }
  })

  test('loadPack creates a layer that is absent and reuses one that exists', async () => {
    const { rows, existingId } = await rolledBack(async (tx, token) => {
      const pack = uniquePack(token)
      const existingKey = (pack.layers[0] as { key: string }).key
      const [existing] = await tx.insert(layer).values({ key: existingKey, label: 'Already here' }).returning()
      const loaded = await loadPack(writePack(token, pack), tx)
      const stored = await tx
        .select({ id: layer.id, key: layer.key, label: layer.label })
        .from(layer)
        .where(inArray(layer.key, pack.layers.map((entry) => entry.key)))
      const used = await tx
        .select({ layerId: requirement.layerId })
        .from(requirement)
        .where(eq(requirement.criteriaSetId, loaded.criteriaSetId))
      return { rows: { stored, used, pack }, existingId: existing?.id }
    })

    // Assert: one row per declared layer, the existing one untouched and still the one in use
    expect(rows.stored.length).toBe(rows.pack.layers.length)
    const existing = rows.stored.find((row) => row.id === existingId)
    expect(existing?.label).toBe('Already here')
    expect(rows.used.some((row) => row.layerId === existingId)).toBe(true)
  })

  test('loadPack rejects a pack carrying a weight', async () => {
    const { error, sets, layers } = await rolledBack(async (tx, token) => {
      const pack = withRequirement(uniquePack(token), 0, { weight: 0.3 })
      const failure = await thrownBy(() => loadPack(writePack(token, pack), tx))
      return {
        error: failure,
        sets: await tx.select().from(criteriaSet).where(eq(criteriaSet.name, pack.name)),
        layers: await layerKeysAmong(tx, pack.layers.map((entry) => entry.key)),
      }
    })

    // Assert: refused by the lint rule, and nothing was written, layers included
    expect(error).toBeInstanceOf(PackCarriesJudgementError)
    expect((error as Error).message).toContain('weight')
    expect(sets).toEqual([])
    expect(layers).toEqual([])
  })

  test('loadPack rejects a pack carrying an apply_threshold', async () => {
    const error = await rolledBack(async (tx, token) => {
      const pack = { ...uniquePack(token), apply_threshold: 0.7 }
      return thrownBy(() => loadPack(writePack(token, pack), tx))
    })

    expect(error).toBeInstanceOf(PackCarriesJudgementError)
    expect((error as Error).message).toContain('apply_threshold')
  })

  test('loadPack rejects a requirement with empty anchors', async () => {
    const { error, sets } = await rolledBack(async (tx, token) => {
      const pack = withRequirement(uniquePack(token), 0, { anchors: {} })
      return {
        error: await thrownBy(() => loadPack(writePack(token, pack), tx)),
        sets: await tx.select().from(criteriaSet).where(eq(criteriaSet.name, pack.name)),
      }
    })

    expect(error).toBeDefined()
    expect(sets).toEqual([])
  })

  test('loadPack is idempotent for the same pack', async () => {
    const { error, setCount, requirementCount, layerCount, first, pack } = await rolledBack(async (tx, token) => {
      const pack = uniquePack(token)
      const file = writePack(token, pack)
      const layerKeys = pack.layers.map((entry) => entry.key)
      const first = await loadPack(file, tx)
      const afterFirst = {
        layers: (await layerKeysAmong(tx, layerKeys)).length,
        requirements: (await tx.select().from(requirement).where(eq(requirement.criteriaSetId, first.criteriaSetId))).length,
      }

      const failure = await thrownBy(() => loadPack(file, tx))

      return {
        error: failure,
        setCount: (await tx.select().from(criteriaSet).where(eq(criteriaSet.name, pack.name))).length,
        requirementCount: (await tx.select().from(requirement).where(eq(requirement.criteriaSetId, first.criteriaSetId))).length - afterFirst.requirements,
        layerCount: (await layerKeysAmong(tx, layerKeys)).length - afterFirst.layers,
        first,
        pack,
      }
    })

    // Assert: the second run is a conflict, and it changed nothing
    expect(error).toBeInstanceOf(CriteriaSetConflictError)
    expect(setCount).toBe(1)
    expect(requirementCount).toBe(0)
    expect(layerCount).toBe(0)
    expect(first.requirementCount).toBe(pack.requirements.length)
  })

  test('loadPack leaves no layers behind when the set already exists', async () => {
    const { error, layers } = await rolledBack(async (tx, token) => {
      const pack = uniquePack(token)
      await insertCriteriaSet(tx, { name: pack.name, version: pack.version })
      const failure = await thrownBy(() => loadPack(writePack(token, pack), tx))
      return { error: failure, layers: await layerKeysAmong(tx, pack.layers.map((entry) => entry.key)) }
    })

    // Assert: layers are created in the same transaction as the set, so the conflict undoes them
    expect(error).toBeInstanceOf(CriteriaSetConflictError)
    expect(layers).toEqual([])
  })

  test('a loaded pack scores a fixture posting to a null overall', async () => {
    // Arrange / Act: load the shipped pack, read it back as the scorer would, rate every
    // requirement as fully covered. The best possible posting still has nothing to be
    // weighed against, because the weights belong to the user's seed interview.
    const result = await rolledBack(async (tx, token) => {
      const loaded = await loadPack(shippedAs(token).file, tx)
      const [set] = await tx.select().from(criteriaSet).where(eq(criteriaSet.id, loaded.criteriaSetId))
      const stored = await tx
        .select({ key: requirement.key, label: requirement.label, kind: requirement.kind, weight: requirement.weight, layerKey: layer.key })
        .from(requirement)
        .innerJoin(layer, eq(requirement.layerId, layer.id))
        .where(eq(requirement.criteriaSetId, loaded.criteriaSetId))
      return scoreAgainstSet({
        requirements: stored.map((row) => ({ ...row, kind: row.kind as 'gate' | 'soft' })),
        ratings: stored.map((row) => ({ requirementKey: row.key, coverage: 1, confidence: 'supported' as const })),
        detours: [],
        penalties: [],
        applyThreshold: set?.applyThreshold ?? null,
      })
    })

    // Assert: this is the template arriving honestly empty, not a defect
    expect(result.overall).toBeNull()
    expect(result.floor).toBeNull()
    expect(result.ceiling).toBeNull()
    expect(result.recommendApply).toBe(false)
  })
})

describe('the seed:pack command', () => {
  /** An io that keeps what was printed, one list per stream. */
  function recorder(): { io: { write(text: string): void; writeError(text: string): void }; out: string[]; err: string[] } {
    const out: string[] = []
    const err: string[] = []
    return { io: { write: (text) => void out.push(text), writeError: (text) => void err.push(text) }, out, err }
  }

  test('prints what it loaded through the io it is given, and exits 0', async () => {
    const { io, out, err } = recorder()

    const code = await main(['pack.json'], io, async () => ({ criteriaSetId: 7, requirementCount: 3 }))

    expect(code).toBe(0)
    expect(out).toEqual(['Loaded criteria set 7 with 3 requirements.\n'])
    expect(err).toEqual([])
  })

  test('says how it is used and exits 2 when no path is given', async () => {
    const { io, out, err } = recorder()

    const code = await main([], io, async () => ({ criteriaSetId: 1, requirementCount: 1 }))

    expect(code).toBe(2)
    expect(out).toEqual([])
    expect(err.join('')).toContain('Usage: bun run seed:pack')
  })

  test('reports a refusal on the error stream and exits 1', async () => {
    const { io, out, err } = recorder()

    const code = await main(['pack.json'], io, async () => {
      throw new Error('the pack carries a weight')
    })

    expect(code).toBe(1)
    expect(out).toEqual([])
    expect(err).toEqual(['the pack carries a weight\n'])
  })
})
