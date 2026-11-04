import { mergeCompanies, updateCompany } from '../../data/repositories/companies.ts'
import { CompanyMergeInputSchema, CompanyUpdateInputSchema } from '../../schemas/companies.ts'
import { defineTool, type ToolDefinition } from '../register.ts'

/** §11.1 companies group: renaming a company, and merging two that are one employer. */
export const companyTools: ToolDefinition[] = [
  defineTool({
    name: 'company_update',
    title: 'Rename a company',
    description:
      'Changes the name or the nameUnresolved flag of ONE company and returns it as stored; fields left out are kept, and an empty patch returns the company unchanged. ' +
      'A new name also changes the key companies are matched on, so a later posting_add under the new spelling reaches this company. ' +
      'Use it to clean an imported name, for example to drop "via recruiter": record how the posting reached you as an origin through a route row instead (origin_record, registry_add). ' +
      'A name another company already holds is a conflict that names that company; if the two are one employer, use company_merge. An unknown id is a not-found error.',
    input: CompanyUpdateInputSchema,
    run: async (args, db) => updateCompany(db, args.companyId, args.patch),
  }),
  defineTool({
    name: 'company_merge',
    title: 'Merge two companies',
    description:
      'Moves every posting of fromCompanyId to intoCompanyId, deletes fromCompanyId, and returns { company, postingsMoved, removedCompanyId }, all as one atomic step. ' +
      'The company kept keeps its own name and nameUnresolved; to keep the other spelling, rename it afterwards with company_update. No alias is kept, so a later import under the removed spelling creates that company again. ' +
      'If both companies hold the same role (same title and disambiguator), nothing is written and the conflict names the postings at each side: give one a disambiguator with posting_update or reject one, then merge again. ' +
      'A company cannot merge into itself, and an unknown id at either side is a not-found error.',
    input: CompanyMergeInputSchema,
    run: async (args, db) => mergeCompanies(db, args),
  }),
]
