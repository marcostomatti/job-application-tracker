import { afterAll, describe, expect, test } from 'bun:test'
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { lintMigrations, lintVanillaPacks } from '../../drizzle/lint/migration-lint'

const FIXTURES = join(import.meta.dir, '..', 'fixtures', 'lint')
const scratchDirs: string[] = []

/** Copy one fixture into its own directory so the lint sees only that file. */
function isolate(fixtureName: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'migration-lint-'))
  scratchDirs.push(dir)
  copyFileSync(join(FIXTURES, fixtureName), join(dir, fixtureName))
  return dir
}

afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true })
})

describe('migration lint', () => {
  test('accepts a migration whose CHECK lists only structural literals', () => {
    // Arrange
    const dir = isolate('good.sql')

    // Act
    const findings = lintMigrations(dir)

    // Assert
    expect(findings).toHaveLength(0)
  })

  test('rejects a CHECK that enumerates gate vocabulary', () => {
    const findings = lintMigrations(isolate('bad-check.sql'))

    expect(findings).toHaveLength(1)
    expect(findings[0]?.rule).toBe('vocabulary-in-check')
    expect(findings[0]?.line).toBe(3)
    expect(findings[0]?.detail).toContain('Icelandic')
  })

  test('rejects a column named after a technology or industry', () => {
    const findings = lintMigrations(isolate('bad-column.sql'))

    expect(findings.map((finding) => finding.rule)).toEqual(['named-column', 'named-column'])
    expect(findings.map((finding) => finding.line)).toEqual([4, 5])
  })

  test('rejects a seed INSERT into a registry table inside a migration', () => {
    const findings = lintMigrations(isolate('bad-seed.sql'))

    expect(findings).toHaveLength(1)
    expect(findings[0]?.rule).toBe('registry-seed')
    expect(findings[0]?.line).toBe(2)
  })

  test('rejects a comment citing a row count or a company name', () => {
    const findings = lintMigrations(isolate('bad-comment.sql'))

    expect(findings.map((finding) => finding.rule)).toEqual(['leaky-comment', 'leaky-comment'])
    expect(findings.map((finding) => finding.line)).toEqual([1, 3])
  })

  test('rejects a vanilla pack carrying a weight or an apply_threshold', () => {
    const bad = lintVanillaPacks(isolate('bad-pack.json'))
    const good = lintVanillaPacks(isolate('good-pack.json'))

    expect(bad).toHaveLength(1)
    expect(bad[0]?.rule).toBe('pack-carries-judgement')
    expect(good).toHaveLength(0)
  })

  test('reports the file and line of every finding', () => {
    const findings = [
      ...lintMigrations(isolate('bad-check.sql')),
      ...lintMigrations(isolate('bad-column.sql')),
      ...lintMigrations(isolate('bad-seed.sql')),
      ...lintMigrations(isolate('bad-comment.sql')),
      ...lintVanillaPacks(isolate('bad-pack.json')),
    ]

    expect(findings.length).toBeGreaterThan(0)
    for (const finding of findings) {
      expect(finding.file.length).toBeGreaterThan(0)
      expect(finding.line).toBeGreaterThanOrEqual(1)
    }
  })
})
