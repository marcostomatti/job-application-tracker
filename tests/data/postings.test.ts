import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { lintMigrations } from '../../drizzle/lint/migration-lint'
import { normaliseName } from '../../src/data/schema/postings.ts'

const MIGRATIONS_DIR = join(import.meta.dir, '..', '..', 'drizzle')

describe('companies, postings, summaries and artefacts', () => {
  test('normaliseName folds, lowercases and collapses punctuation', () => {
    // Arrange / Act / Assert: the brief's pair, then accents, which NFKD splits into marks
    expect(normaliseName('Acme  Inc.')).toBe('acme inc')
    expect(normaliseName('ACME-INC')).toBe('acme inc')
    expect(normaliseName('  Café   Müller & Söhne!! ')).toBe('cafe muller sohne')
    expect(normaliseName('ＡＢＣ　Ｌｔｄ')).toBe('abc ltd')
    expect(normaliseName('株式会社 テスト')).toBe('株式会社 テスト')
  })

  test('normaliseName keeps marks that change a non-Latin letter', () => {
    // Arrange / Act / Assert: a voiced kana and its plain form are different employers
    expect(normaliseName('バンク')).not.toBe(normaliseName('ハンク'))
    expect(normaliseName('バンク')).toBe('バンク')
    // Half-width forms still fold onto the full-width name
    expect(normaliseName('ﾊﾞﾝｸ')).toBe(normaliseName('バンク'))
    // Devanagari vowel signs and the virama carry the word
    expect(normaliseName('हिन्दी')).toBe('हिन्दी')
    expect(normaliseName('हिन्दी')).not.toBe(normaliseName('हनद'))
    // Cyrillic and Greek marks are not Latin diacritics either
    expect(normaliseName('й')).not.toBe(normaliseName('и'))
    expect(normaliseName('ά')).not.toBe(normaliseName('α'))
  })

  test('normaliseName keeps punctuation-only names apart', () => {
    // Arrange / Act / Assert: nothing alphanumeric survives, so the raw text is the key
    expect(normaliseName('&')).toBe('&')
    expect(normaliseName('!!!')).toBe('!!!')
    expect(normaliseName('&')).not.toBe(normaliseName('!!!'))
    expect(normaliseName('  &  ')).toBe('&')
  })

  test('the migration passes the lint', () => {
    // Arrange: the table was created as position in 0002 and renamed in 0012
    const migration = join(MIGRATIONS_DIR, '0002_positions.sql')

    // Act
    const findings = lintMigrations(MIGRATIONS_DIR).filter((finding) => finding.file === migration)

    // Assert: the file must exist, or "no findings" would pass for the wrong reason
    expect(existsSync(migration)).toBe(true)
    expect(findings).toEqual([])
  })

  test('the rename migration passes the lint', () => {
    // Arrange
    const migration = join(MIGRATIONS_DIR, '0012_rename_position_to_posting.sql')

    // Act
    const findings = lintMigrations(MIGRATIONS_DIR).filter((finding) => finding.file === migration)

    // Assert: the file must exist, or "no findings" would pass for the wrong reason
    expect(existsSync(migration)).toBe(true)
    expect(findings).toEqual([])
  })
})
