import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'

import { lintMigrations } from '../../drizzle/lint/migration-lint'
import { closeDb } from '../../src/data/client.ts'
import { company, normaliseName, position, positionSummary } from '../../src/data/schema/positions.ts'
import { rolledBack, thrownInSavepoint, violationText, type Tx } from './rolled-back.ts'

const MIGRATIONS_DIR = join(import.meta.dir, '..', '..', 'drizzle')

/** Words that would make a column a place to keep a secret. `key` matches as a whole word only. */
const CREDENTIAL_WORDS = ['password', 'passwd', 'passphrase', 'secret', 'token', 'credential', 'credentials', 'key']

function isCredentialColumn(columnName: string): boolean {
  return columnName.split('_').some((part) => CREDENTIAL_WORDS.includes(part))
}

async function insertCompany(tx: Tx, name: string) {
  const [created] = await tx.insert(company).values({ name, nameNorm: normaliseName(name) }).returning()
  return created as NonNullable<typeof created>
}

function roleValues(companyId: number, token: string, extra: { disambiguator?: string } = {}) {
  return {
    positionKey: `test-position-${token}-${extra.disambiguator ?? 'none'}`,
    companyId,
    roleTitle: 'Staff Engineer',
    roleNorm: normaliseName('Staff Engineer'),
    ...extra,
  }
}

afterAll(async () => {
  await closeDb()
})

describe('companies, positions, summaries and artefacts', () => {
  test('normaliseName folds, lowercases and collapses punctuation', () => {
    // Arrange / Act / Assert: the brief's pair, then accents, which NFKD splits into marks
    expect(normaliseName('Acme  Inc.')).toBe('acme inc')
    expect(normaliseName('ACME-INC')).toBe('acme inc')
    expect(normaliseName('  Café   Müller & Söhne!! ')).toBe('cafe muller sohne')
    expect(normaliseName('ＡＢＣ　Ｌｔｄ')).toBe('abc ltd')
    expect(normaliseName('株式会社 テスト')).toBe('株式会社 テスト')
  })

  test('company name_norm is unique', async () => {
    // Arrange / Act
    const { error, otherSpelling } = await rolledBack(async (tx, token) => {
      await insertCompany(tx, `Acme ${token} Inc.`)
      const error = await thrownInSavepoint(tx, (inner) => insertCompany(inner, `ACME-${token}-INC`))
      const otherSpelling = await thrownInSavepoint(tx, (inner) => insertCompany(inner, `Acme ${token} Ltd`))
      return { error, otherSpelling }
    })

    // Assert: two spellings of one employer are one row; a different employer is still allowed
    expect(violationText(error)).toContain('company_name_norm_unique')
    expect(otherSpelling).toBeUndefined()
  })

  test('two different roles with one title coexist via the disambiguator', async () => {
    // Arrange / Act
    const rows = await rolledBack(async (tx, token) => {
      const owner = await insertCompany(tx, `Globex ${token}`)
      await tx.insert(position).values(roleValues(owner.id, token, { disambiguator: 'platform team' }))
      await tx.insert(position).values(roleValues(owner.id, token, { disambiguator: 'data team' }))
      return tx.select().from(position).where(sql`${position.companyId} = ${owner.id}`)
    })

    // Assert: scoped to the company this test created
    expect(rows.map((row) => row.disambiguator).sort()).toEqual(['data team', 'platform team'])
  })

  test('the same company, role and disambiguator cannot be inserted twice', async () => {
    // Arrange / Act
    const { blank, named } = await rolledBack(async (tx, token) => {
      const owner = await insertCompany(tx, `Initech ${token}`)
      // The default disambiguator is '' rather than null, because null would make two blanks distinct
      await tx.insert(position).values({ ...roleValues(owner.id, token), positionKey: `a-${token}` })
      await tx.insert(position).values({ ...roleValues(owner.id, token, { disambiguator: 'x' }), positionKey: `b-${token}` })
      const blank = await thrownInSavepoint(tx, (inner) =>
        inner.insert(position).values({ ...roleValues(owner.id, token), positionKey: `c-${token}` }),
      )
      const named = await thrownInSavepoint(tx, (inner) =>
        inner.insert(position).values({ ...roleValues(owner.id, token, { disambiguator: 'x' }), positionKey: `d-${token}` }),
      )
      return { blank, named }
    })

    // Assert
    expect(violationText(blank)).toContain('position_company_role_disambiguator_unique')
    expect(violationText(named)).toContain('position_company_role_disambiguator_unique')
  })

  test('a position summary is one row per position', async () => {
    // Arrange / Act
    const { first, second } = await rolledBack(async (tx, token) => {
      const owner = await insertCompany(tx, `Umbrella ${token}`)
      const [role] = await tx.insert(position).values(roleValues(owner.id, token)).returning()
      const summary = { positionId: role?.id as number, condensed: 'the posting, noise stripped', sourceHash: 'h1' }
      const [first] = await tx.insert(positionSummary).values(summary).returning()
      const second = await thrownInSavepoint(tx, (inner) =>
        inner.insert(positionSummary).values({ ...summary, sourceHash: 'h2' }),
      )
      return { first, second }
    })

    // Assert: a repost changes source_hash on the one row; it does not add a second
    expect(first?.stack).toEqual([])
    expect(first?.extra).toEqual({})
    expect(violationText(second)).toContain('position_summary_pkey')
  })

  test('an artefact stores a locator and an access note but no credential column', async () => {
    // Arrange: read the live columns, so a column added later is judged too
    const columns = await rolledBack(async (tx) => {
      const rows = await tx.execute<{ column_name: string }>(sql`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'artefact'`)
      return Array.from(rows, (row) => row.column_name)
    })

    // Assert: the table exists, holds a reference, and the detector can in fact fire
    expect(columns).toContain('locator')
    expect(columns).toContain('access_note')
    expect(columns.filter(isCredentialColumn)).toEqual([])
    expect(['api_key', 'access_token', 'db_password', 'client_secret'].every(isCredentialColumn)).toBe(true)
    expect(isCredentialColumn('artefact_kind_id')).toBe(false)
  })

  test('the migration passes the lint', () => {
    // Arrange
    const migration = join(MIGRATIONS_DIR, '0002_positions.sql')

    // Act
    const findings = lintMigrations(MIGRATIONS_DIR).filter((finding) => finding.file === migration)

    // Assert: the file must exist, or "no findings" would pass for the wrong reason
    expect(existsSync(migration)).toBe(true)
    expect(findings).toEqual([])
  })
})
