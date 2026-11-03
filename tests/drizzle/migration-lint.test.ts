import { afterAll, describe, expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
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

  test('the lint:migrations script lints the checkout it lives in, whatever the working directory', () => {
    // Arrange: a checkout holding a copy of the script and one bad migration
    const root = mkdtempSync(join(tmpdir(), 'migration-lint-checkout-'))
    const elsewhere = mkdtempSync(join(tmpdir(), 'migration-lint-cwd-'))
    scratchDirs.push(root, elsewhere)
    mkdirSync(join(root, 'drizzle', 'lint'), { recursive: true })
    for (const name of ['migration-lint.ts', 'forbidden.ts']) {
      copyFileSync(join(FIXTURE_ROOT, 'drizzle', 'lint', name), join(root, 'drizzle', 'lint', name))
    }
    copyFileSync(join(FIXTURES, 'bad-check.sql'), join(root, 'drizzle', 'bad-check.sql'))
    const script = join(root, 'drizzle', 'lint', 'migration-lint.ts')

    // Act: run it from a directory that has no drizzle/ of its own
    const result = Bun.spawnSync([process.execPath, script], { cwd: elsewhere })

    // Assert: the bad migration is found, with a path relative to the checkout
    expect(result.exitCode).toBe(1)
    expect(result.stdout.toString()).toContain('drizzle/bad-check.sql:3 vocabulary-in-check')
  })

  test('does not read a column named copy as a COPY statement, but still rejects COPY', () => {
    expect(lintMigrations(isolate('copy-column.sql'))).toHaveLength(0)

    const findings = lintMigrations(isolate('copy-statement.sql'))

    expect(findings.map((finding) => finding.rule)).toEqual(['registry-seed'])
  })

  test('does not read prose such as "3 lines" or a "3." list marker as a row count, but still rejects "93 records"', () => {
    expect(lintMigrations(isolate('prose-comments.sql'))).toHaveLength(0)

    const findings = lintMigrations(isolate('evade-phrasings.sql'))

    expect(findings).toHaveLength(5)
  })

  test('rejects a column renamed with RENAME a TO b (no COLUMN keyword), and allows a clean rename', () => {
    const bad = lintMigrations(isolate('evade-rename-nocolumn.sql'))
    const legit = lintMigrations(isolate('rename-legit.sql'))

    expect(bad.map((finding) => finding.rule)).toEqual(['named-column'])
    expect(bad[0]?.line).toBe(2)
    expect(legit).toHaveLength(0)
  })

  test('rejects a dollar-quoted COMMENT ON text that cites a row count or a name, and allows a clean one', () => {
    const bad = lintMigrations(isolate('evade-comment-dollar.sql'))
    const legit = lintMigrations(isolate('comment-on-legit.sql'))

    expect(bad.map((finding) => finding.rule)).toEqual(['leaky-comment', 'leaky-comment'])
    expect(bad.map((finding) => finding.line)).toEqual([2, 3])
    expect(legit).toHaveLength(0)
  })

  test('rejects MERGE ... THEN INSERT with no INTO, and does not read a BEFORE INSERT trigger as a seed', () => {
    const bad = lintMigrations(isolate('evade-merge-insert.sql'))
    const trigger = lintMigrations(isolate('trigger-legit.sql'))

    expect(bad.map((finding) => finding.rule)).toEqual(['registry-seed'])
    expect(bad[0]?.line).toBe(2)
    // CREATE TRIGGER is forbidden outright now, but BEFORE INSERT is still not a seed.
    expect(trigger.map((finding) => finding.rule)).toEqual(['forbidden-routine'])
  })

  test('rejects ALTER TYPE RENAME VALUE to a vocabulary word, and allows a rename to a structural one', () => {
    const findings = lintMigrations(isolate('evade-rename-value.sql'))

    expect(findings.map((finding) => finding.rule)).toEqual(['vocabulary-in-check'])
    expect(findings[0]?.line).toBe(2)
    expect(findings[0]?.detail).toContain('Icelandic')
  })

  test('rejects vocabulary in a column DEFAULT, and allows structural defaults', () => {
    const bad = lintMigrations(isolate('evade-default.sql'))
    const legit = lintMigrations(isolate('structural-defaults.sql'))

    expect(bad.map((finding) => finding.rule)).toEqual(['vocabulary-in-check', 'vocabulary-in-check'])
    expect(bad.map((finding) => finding.line)).toEqual([3, 6])
    expect(bad[0]?.detail).toContain('Icelandic')
    expect(legit).toEqual([])
  })

  test('rejects vocabulary in an index WHERE predicate, and allows a structural predicate', () => {
    const bad = lintMigrations(isolate('evade-index-where.sql'))
    const legit = lintMigrations(isolate('structural-index.sql'))

    expect(bad.map((finding) => finding.rule)).toEqual(['vocabulary-in-check'])
    expect(bad[0]?.line).toBe(2)
    expect(bad[0]?.detail).toContain('Elixir')
    expect(legit).toEqual([])
  })

  test('rejects vocabulary in a GENERATED ... AS (expression), and allows a structural one', () => {
    const bad = lintMigrations(isolate('evade-generated.sql'))
    const legit = lintMigrations(isolate('structural-generated.sql'))

    expect(bad.map((finding) => finding.rule)).toEqual(['vocabulary-in-check'])
    expect(bad[0]?.line).toBe(3)
    expect(bad[0]?.detail).toContain('Crypto')
    expect(legit).toEqual([])
  })

  test('rejects vocabulary in a view body, and allows a structural one', () => {
    const bad = lintMigrations(isolate('evade-view-body.sql'))
    const legit = lintMigrations(isolate('structural-view.sql'))

    expect(bad.map((finding) => finding.rule)).toEqual(['vocabulary-in-check'])
    expect(bad[0]?.detail).toContain('Hybrid')
    expect(legit).toEqual([])
  })

  test('rejects a table, index, type or constraint named after vocabulary, and allows clean names', () => {
    const bad = lintMigrations(isolate('evade-object-names.sql'))
    const legit = lintMigrations(isolate('clean-object-names.sql'))

    expect(bad.map((finding) => finding.rule)).toEqual(Array(5).fill('named-object'))
    expect(bad.map((finding) => finding.line)).toEqual([1, 2, 3, 4, 5])
    expect(legit).toEqual([])
  })

  test('forbids CREATE FUNCTION, CREATE TRIGGER and DO blocks, and ignores the words elsewhere', () => {
    const bad = lintMigrations(isolate('evade-function-body.sql'))
    const legit = lintMigrations(isolate('routine-lookalikes.sql'))

    expect(bad.map((finding) => finding.rule)).toEqual(Array(3).fill('forbidden-routine'))
    expect(bad.map((finding) => finding.line)).toEqual([1, 2, 3])
    expect(legit).toEqual([])
  })
})
