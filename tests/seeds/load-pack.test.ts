import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { lintVanillaPacks } from '../../drizzle/lint/migration-lint'
import { VanillaPackSchema } from '../../src/schemas/scoring.ts'
import { main } from '../../src/seeds/load-pack.ts'

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

const withRequirement = (pack: RawPack, index: number, change: Record<string, unknown>): RawPack => ({
  ...pack,
  requirements: pack.requirements.map((entry, at) => (at === index ? { ...entry, ...change } : entry)),
})

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
