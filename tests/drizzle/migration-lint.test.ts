import { afterAll, describe, expect, test } from 'bun:test'
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as migrationLint from '../../drizzle/lint/migration-lint'

const { lintMigrations, lintVanillaPacks } = migrationLint
const FIXTURE_ROOT = join(import.meta.dir, '..', '..')
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

  test('rejects a wrapped comment that splits a row count or a name across lines', () => {
    const findings = lintMigrations(isolate('evade-wrapped-comment.sql'))

    expect(findings.map((finding) => finding.rule)).toEqual(['leaky-comment', 'leaky-comment'])
    expect(findings.map((finding) => finding.line)).toEqual([1, 4])
  })

  test('rejects a count written as 10k rows, 1.2M rows, 93 row, 93 records or 93 entries', () => {
    const findings = lintMigrations(isolate('evade-phrasings.sql'))

    expect(findings.map((finding) => finding.line)).toEqual([1, 3, 5, 7, 9])
  })

  test('rejects a camelCase or run-together column named after a technology or industry', () => {
    const findings = lintMigrations(isolate('evade-camel-column.sql'))

    expect(findings.map((finding) => finding.rule)).toEqual(['named-column', 'named-column', 'named-column'])
    expect(findings.map((finding) => finding.line)).toEqual([3, 4, 5])
  })

  test('rejects a column renamed to a denied name by RENAME COLUMN', () => {
    const findings = lintMigrations(isolate('evade-rename-column.sql'))

    expect(findings).toHaveLength(1)
    expect(findings[0]?.rule).toBe('named-column')
    expect(findings[0]?.line).toBe(2)
  })

  test('rejects a COMMENT ON text that cites a row count or a company name', () => {
    const findings = lintMigrations(isolate('evade-comment-on.sql'))

    expect(findings.map((finding) => finding.rule)).toEqual(['leaky-comment', 'leaky-comment'])
    expect(findings.map((finding) => finding.line)).toEqual([2, 2])
  })

  test('rejects vocabulary in a CREATE TYPE ENUM or an ALTER TYPE ADD VALUE', () => {
    const findings = lintMigrations(isolate('evade-enum.sql'))

    expect(findings.map((finding) => finding.rule)).toEqual(['vocabulary-in-check', 'vocabulary-in-check'])
    expect(findings.map((finding) => finding.line)).toEqual([1, 2])
    expect(findings[0]?.detail).toContain('Icelandic')
    expect(findings[1]?.detail).toContain('Elixir')
  })

  test('rejects any INSERT or COPY, whatever the table, and allows UPDATE', () => {
    const findings = lintMigrations(isolate('evade-seed-unlisted.sql'))

    expect(findings.map((finding) => finding.rule)).toEqual(['registry-seed', 'registry-seed'])
    expect(findings.map((finding) => finding.line)).toEqual([2, 3])
  })

  test('ignores denied words and INSERT inside a string literal', () => {
    const findings = lintMigrations(isolate('string-literal-lookalike.sql'))

    expect(findings).toHaveLength(0)
  })

  test('reports a missing drizzle directory instead of passing', () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), 'migration-lint-root-'))
    scratchDirs.push(emptyRoot)

    const result = migrationLint.lintRepo(emptyRoot)

    expect(result.findings).toHaveLength(0)
    expect(result.problems).toHaveLength(1)
    expect(result.problems[0]).toContain('drizzle')
  })

  test('the lint:migrations script gives the same result from any working directory', () => {
    const script = join(FIXTURE_ROOT, 'drizzle', 'lint', 'migration-lint.ts')
    const run = (cwd: string) => {
      const result = Bun.spawnSync([process.execPath, script], { cwd })
      return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() }
    }

    const fromRoot = run(FIXTURE_ROOT)
    const fromElsewhere = run(tmpdir())

    expect(fromElsewhere).toEqual(fromRoot)
    expect(fromElsewhere.err).not.toContain('drizzle/ not found')
  })
})
