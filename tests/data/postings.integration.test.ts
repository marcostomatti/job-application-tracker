import { afterAll, describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'

import { closeDb } from '../../src/data/client.ts'
import { company, normaliseName, posting, postingSummary } from '../../src/data/schema/postings.ts'
import { rolledBack, thrownInSavepoint, violationText, type Tx } from './rolled-back.ts'

/** Fragments that would make a column a place to keep a secret. */
const CREDENTIAL_FRAGMENTS = [
  'password',
  'passwd',
  'pwd',
  'passphrase',
  'secret',
  'token',
  'credential',
  'apikey',
  'accesskey',
  'privatekey',
  'bearer',
  'cookie',
]

/**
 * Fragments are matched inside the name with underscores removed, so `api_key`, `apikey` and
 * `ApiKey` are all caught. A bare `key` is matched as a whole word only, because it sits
 * inside harmless words.
 */
function isCredentialColumn(columnName: string): boolean {
  const lowered = columnName.toLowerCase()
  const joined = lowered.replaceAll('_', '')
  return CREDENTIAL_FRAGMENTS.some((fragment) => joined.includes(fragment)) || lowered.split('_').includes('key')
}

async function insertCompany(tx: Tx, name: string) {
  const [created] = await tx.insert(company).values({ name, nameNorm: normaliseName(name) }).returning()
  return created as NonNullable<typeof created>
}

function roleValues(companyId: number, token: string, extra: { disambiguator?: string } = {}) {
  return {
    postingKey: `test-posting-${token}-${extra.disambiguator ?? 'none'}`,
    companyId,
    roleTitle: 'Staff Engineer',
    roleNorm: normaliseName('Staff Engineer'),
    ...extra,
  }
}

afterAll(async () => {
  await closeDb()
})

describe('companies, postings, summaries and artefacts', () => {
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
      await tx.insert(posting).values(roleValues(owner.id, token, { disambiguator: 'platform team' }))
      await tx.insert(posting).values(roleValues(owner.id, token, { disambiguator: 'data team' }))
      return tx.select().from(posting).where(sql`${posting.companyId} = ${owner.id}`)
    })

    // Assert: scoped to the company this test created
    expect(rows.map((row) => row.disambiguator).sort()).toEqual(['data team', 'platform team'])
  })

  test('the same company, role and disambiguator cannot be inserted twice', async () => {
    // Arrange / Act
    const { blank, named } = await rolledBack(async (tx, token) => {
      const owner = await insertCompany(tx, `Initech ${token}`)
      // The default disambiguator is '' rather than null, because null would make two blanks distinct
      await tx.insert(posting).values({ ...roleValues(owner.id, token), postingKey: `a-${token}` })
      await tx.insert(posting).values({ ...roleValues(owner.id, token, { disambiguator: 'x' }), postingKey: `b-${token}` })
      const blank = await thrownInSavepoint(tx, (inner) =>
        inner.insert(posting).values({ ...roleValues(owner.id, token), postingKey: `c-${token}` }),
      )
      const named = await thrownInSavepoint(tx, (inner) =>
        inner.insert(posting).values({ ...roleValues(owner.id, token, { disambiguator: 'x' }), postingKey: `d-${token}` }),
      )
      return { blank, named }
    })

    // Assert
    expect(violationText(blank)).toContain('posting_company_role_disambiguator_unique')
    expect(violationText(named)).toContain('posting_company_role_disambiguator_unique')
  })

  test('a posting summary is one row per posting', async () => {
    // Arrange / Act
    const { first, second } = await rolledBack(async (tx, token) => {
      const owner = await insertCompany(tx, `Umbrella ${token}`)
      const [role] = await tx.insert(posting).values(roleValues(owner.id, token)).returning()
      const summary = { postingId: role?.id as number, condensed: 'the posting, noise stripped', sourceHash: 'h1' }
      const [first] = await tx.insert(postingSummary).values(summary).returning()
      const second = await thrownInSavepoint(tx, (inner) =>
        inner.insert(postingSummary).values({ ...summary, sourceHash: 'h2' }),
      )
      return { first, second }
    })

    // Assert: a repost changes source_hash on the one row; it does not add a second
    expect(first?.stack).toEqual([])
    expect(first?.extra).toEqual({})
    expect(violationText(second)).toContain('posting_summary_pkey')
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
    const spellings = ['api_key', 'apikey', 'accesskey', 'pwd', 'bearer', 'session_cookie', 'db_password', 'client_secret']
    expect(spellings.every(isCredentialColumn)).toBe(true)
    const harmless = ['id', 'artefact_kind_id', 'label', 'locator', 'access_note', 'created_at', 'monkey_count']
    expect(harmless.some(isCredentialColumn)).toBe(false)
  })
})
