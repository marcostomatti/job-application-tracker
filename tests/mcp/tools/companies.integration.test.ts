import { describe, expect, test } from 'bun:test'

import { addPostings } from '../../../src/data/repositories/postings.ts'
import { companyTools } from '../../../src/mcp/tools/companies.ts'
import { connectTools, failureText, untouchableDb, useSharedScratchDatabase } from './harness.ts'

const database = useSharedScratchDatabase()

async function companyIdFor(name: string, roleTitle: string): Promise<number> {
  const [created] = await addPostings(database(), [{ company: { name }, roleTitle }])
  if (!created) throw new Error('the arrangement stored no posting')
  return created.companyId
}

describe('the companies group', () => {
  test('registers exactly the named tools, with no annotations', () => {
    expect(companyTools.map((tool) => tool.name).sort()).toEqual(['company_merge', 'company_update'])
    expect(companyTools.filter((tool) => tool.annotations !== undefined)).toEqual([])
  })

  test('company_update renames a company and returns it as stored', async () => {
    const client = await connectTools(companyTools, database())
    const id = await companyIdFor('Tool Rename via recruiter', 'Tool rename role')

    const outcome = await client.call('company_update', { companyId: id, patch: { name: 'Tool Rename' } })

    expect(outcome.failed).toBe(false)
    expect(outcome.body).toMatchObject({ id, name: 'Tool Rename' })
  })

  test('company_update names company_merge when the name is taken', async () => {
    const client = await connectTools(companyTools, database())
    await companyIdFor('Tool Taken', 'Taken role')
    const other = await companyIdFor('Tool Other', 'Other role')

    const outcome = await client.call('company_update', { companyId: other, patch: { name: 'tool taken' } })

    expect(outcome.failed).toBe(true)
    expect(failureText(outcome)).toContain('company_merge')
  })

  test('company_merge moves the postings and reports the count and the id removed', async () => {
    const client = await connectTools(companyTools, database())
    const into = await companyIdFor('Tool Merge Into', 'Into role')
    const from = await companyIdFor('Tool Merge From', 'From role')

    const outcome = await client.call('company_merge', { intoCompanyId: into, fromCompanyId: from })

    expect(outcome.body).toMatchObject({ company: { id: into }, postingsMoved: 1, removedCompanyId: from })
  })

  test('company_merge refuses a merge into itself before touching the database', async () => {
    const client = await connectTools(companyTools, untouchableDb())

    const outcome = await client.call('company_merge', { intoCompanyId: 5, fromCompanyId: 5 })

    expect(outcome.failed).toBe(true)
    expect(failureText(outcome)).toContain('merged into itself')
  })

  test('company_update refuses a patch column it does not name before touching the database', async () => {
    const client = await connectTools(companyTools, untouchableDb())

    const outcome = await client.call('company_update', { companyId: 5, patch: { nameNorm: 'forged' } })

    expect(outcome.failed).toBe(true)
  })
})
