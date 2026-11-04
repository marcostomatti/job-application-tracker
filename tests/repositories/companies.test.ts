import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'

import { findCompany, mergeCompanies, updateCompany } from '../../src/data/repositories/companies.ts'
import { addPostings } from '../../src/data/repositories/postings.ts'
import { company, posting } from '../../src/data/schema/postings.ts'
import { ConflictError, NotFoundError, statusFor } from '../../src/errors.ts'
import { CompanyMergeInputSchema, CompanyUpdateInputSchema } from '../../src/schemas/companies.ts'
import { thrownBy } from '../data/rolled-back.ts'
import { useSharedScratchDatabase } from '../mcp/tools/harness.ts'

const database = useSharedScratchDatabase()

/** Stores one posting per role at a company of that name, and returns the company's id and the postings' ids. */
async function companyWith(name: string, roles: readonly string[], nameUnresolved = false): Promise<{ id: number; postingIds: number[] }> {
  const rows = await addPostings(
    database(),
    roles.map((roleTitle) => ({ company: { name, nameUnresolved }, roleTitle })),
  )
  const first = rows[0]
  if (!first) throw new Error('the arrangement stored no posting')
  return { id: first.companyId, postingIds: rows.map((row) => row.id) }
}

async function companyIdsOf(postingIds: readonly number[]): Promise<number[]> {
  const rows = await Promise.all(
    postingIds.map(async (id) => (await database().select().from(posting).where(eq(posting.id, id)))[0]?.companyId),
  )
  return rows.filter((id): id is number => id !== undefined)
}

describe('updateCompany', () => {
  test('renames a company and recomputes the key it is matched on', async () => {
    // Arrange
    const { id } = await companyWith('Acme via recruiter', ['Renamed role'])

    // Act
    const renamed = await updateCompany(database(), id, { name: 'Acme Renamed' })

    // Assert
    expect(renamed).toMatchObject({ id, name: 'Acme Renamed', nameNorm: 'acme renamed' })
    expect(await findCompany(database(), id)).toEqual(renamed)
  })

  test('a later import under the new spelling reaches the renamed company', async () => {
    // Arrange
    const { id } = await companyWith('Rename Target Old', ['Old role'])
    await updateCompany(database(), id, { name: 'Rename Target New' })

    // Act
    const [added] = await addPostings(database(), [{ company: { name: 'rename target new' }, roleTitle: 'New role' }])

    // Assert
    expect(added?.companyId).toBe(id)
  })

  test('clears the unresolved flag without touching the name', async () => {
    // Arrange
    const { id } = await companyWith('Placeholder Employer', ['Placeholder role'], true)

    // Act
    const resolved = await updateCompany(database(), id, { nameUnresolved: false })

    // Assert
    expect(resolved).toMatchObject({ name: 'Placeholder Employer', nameUnresolved: false })
  })

  test('accepts a new spelling of its own key, such as a change of case', async () => {
    // Arrange
    const { id } = await companyWith('case co', ['Case role'])

    // Act
    const renamed = await updateCompany(database(), id, { name: 'Case Co' })

    // Assert
    expect(renamed).toMatchObject({ id, name: 'Case Co', nameNorm: 'case co' })
  })

  test('returns the stored row for an empty patch', async () => {
    // Arrange
    const { id } = await companyWith('Untouched Co', ['Untouched role'])
    const before = await findCompany(database(), id)

    // Act
    const after = await updateCompany(database(), id, {})

    // Assert
    expect(after).toEqual(before)
  })

  test('refuses a name another company holds, naming that company and company_merge', async () => {
    // Arrange
    const taken = await companyWith('Taken Name Co', ['Taken role'])
    const other = await companyWith('Other Name Co', ['Other role'])

    // Act
    const error = await thrownBy(() => updateCompany(database(), other.id, { name: 'TAKEN NAME CO.' }))

    // Assert
    expect(error).toBeInstanceOf(ConflictError)
    expect(statusFor(error)).toBe(409)
    expect((error as Error).message).toContain(`company ${taken.id}`)
    expect((error as Error).message).toContain('company_merge')
    expect((await findCompany(database(), other.id)).name).toBe('Other Name Co')
  })

  test('an unknown company is a not-found error', async () => {
    // Act
    const error = await thrownBy(() => updateCompany(database(), 999_999, { name: 'Nobody' }))

    // Assert
    expect(error).toBeInstanceOf(NotFoundError)
  })
})

describe('mergeCompanies', () => {
  test('moves every posting to the company kept, removes the other, and reports the count', async () => {
    // Arrange
    const into = await companyWith('Merge Into Co', ['Kept role'])
    const from = await companyWith('Merge From Co via recruiter', ['Moved one', 'Moved two'])

    // Act
    const result = await mergeCompanies(database(), { intoCompanyId: into.id, fromCompanyId: from.id })

    // Assert
    expect(result).toMatchObject({ company: { id: into.id, name: 'Merge Into Co' }, postingsMoved: 2, removedCompanyId: from.id })
    expect(await companyIdsOf(from.postingIds)).toEqual([into.id, into.id])
    expect(await database().select().from(company).where(eq(company.id, from.id))).toEqual([])
  })

  test('keeps the name and flag of the company kept, even when the other was resolved', async () => {
    // Arrange
    const into = await companyWith('Unresolved Keeper', ['Keeper role'], true)
    const from = await companyWith('Resolved Loser', ['Loser role'])

    // Act
    const result = await mergeCompanies(database(), { intoCompanyId: into.id, fromCompanyId: from.id })

    // Assert
    expect(result.company).toMatchObject({ name: 'Unresolved Keeper', nameUnresolved: true })
  })

  test('merges a company with no postings, reporting none moved', async () => {
    // Arrange
    const into = await companyWith('Empty Merge Into', ['Only role'])
    const [created] = await database().insert(company).values({ name: 'Empty Shell', nameNorm: 'empty shell' }).returning()
    if (!created) throw new Error('the arrangement stored no company')

    // Act
    const result = await mergeCompanies(database(), { intoCompanyId: into.id, fromCompanyId: created.id })

    // Assert
    expect(result.postingsMoved).toBe(0)
  })

  test('refuses a role both companies hold, names the postings at each side, and writes nothing', async () => {
    // Arrange
    const into = await companyWith('Clash Into Co', ['Shared Role', 'Into only'])
    const from = await companyWith('Clash From Co', ['shared role', 'From only'])

    // Act
    const error = await thrownBy(() => mergeCompanies(database(), { intoCompanyId: into.id, fromCompanyId: from.id }))

    // Assert
    expect(error).toBeInstanceOf(ConflictError)
    expect((error as Error).message).toContain(`posting ${from.postingIds[0]}`)
    expect((error as Error).message).toContain(`posting ${into.postingIds[0]}`)
    expect(await companyIdsOf(from.postingIds)).toEqual([from.id, from.id])
    expect((await findCompany(database(), from.id)).id).toBe(from.id)
  })

  test('treats one role with two disambiguators as two roles, so they merge', async () => {
    // Arrange
    const into = await companyWith('Disambiguated Into', ['Same role'])
    const [moved] = await addPostings(database(), [
      { company: { name: 'Disambiguated From' }, roleTitle: 'Same role', disambiguator: 'second team' },
    ])
    if (!moved) throw new Error('the arrangement stored no posting')

    // Act
    const result = await mergeCompanies(database(), { intoCompanyId: into.id, fromCompanyId: moved.companyId })

    // Assert
    expect(result.postingsMoved).toBe(1)
  })

  test('an unknown company at either side is a not-found error and nothing moves', async () => {
    // Arrange
    const real = await companyWith('Merge Real Co', ['Real role'])

    // Act
    const missingInto = await thrownBy(() => mergeCompanies(database(), { intoCompanyId: 999_999, fromCompanyId: real.id }))
    const missingFrom = await thrownBy(() => mergeCompanies(database(), { intoCompanyId: real.id, fromCompanyId: 999_999 }))

    // Assert
    expect(missingInto).toBeInstanceOf(NotFoundError)
    expect(missingFrom).toBeInstanceOf(NotFoundError)
    expect(await companyIdsOf(real.postingIds)).toEqual([real.id])
  })
})

describe('the company schemas', () => {
  test('a merge of a company into itself is refused', () => {
    // Assert
    expect(CompanyMergeInputSchema.safeParse({ intoCompanyId: 3, fromCompanyId: 3 }).success).toBe(false)
    expect(CompanyMergeInputSchema.safeParse({ intoCompanyId: 3, fromCompanyId: 4 }).success).toBe(true)
  })

  test('an update refuses a blank name and a column it does not name', () => {
    // Assert
    expect(CompanyUpdateInputSchema.safeParse({ companyId: 1, patch: { name: '  ' } }).success).toBe(false)
    expect(CompanyUpdateInputSchema.safeParse({ companyId: 1, patch: { nameNorm: 'x' } }).success).toBe(false)
  })
})
