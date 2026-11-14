import { describe, expect, test } from 'bun:test'
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core'

import { requirement } from '../../src/data/schema/criteria.ts'
import { postingRating, postingScore } from '../../src/data/schema/scores.ts'
import { RATING_CONFIDENCES, REQUIREMENT_KINDS } from '../../src/schemas/discriminators.ts'
import { AGENT_VERDICTS } from '../../src/schemas/recommendation.ts'

/**
 * Every quoted literal in a CHECK's text. Postgres rewrites `IN ('a', 'b')` as
 * `= ANY (ARRAY['a'::text, 'b'::text])`, so the list cannot be matched by its keyword, but
 * these constraints compare a column with nothing else quoted, so the literals are the members.
 */
function membersOf(checkText: string): string[] {
  return [...checkText.matchAll(/'([^']*)'/g)].map((match) => match[1] as string)
}

const CHECKS = [
  { constraint: 'requirement_kind_check', table: requirement, members: REQUIREMENT_KINDS },
  { constraint: 'posting_rating_confidence_check', table: postingRating, members: RATING_CONFIDENCES },
  { constraint: 'posting_score_agent_verdict_check', table: postingScore, members: AGENT_VERDICTS },
] as const

/**
 * `gate|soft` and `supported|partial|unknown` are accepted by the zod schemas (which import one
 * constant each from `src/schemas/discriminators.ts`) and by a CHECK constraint, which is SQL
 * and cannot import anything. This is what ties the two: a member added to the constant and not
 * to the migration would be a 500 on every row of the new kind, and the reverse a database that
 * accepts what the API refuses.
 */
describe('structural discriminators match their CHECK constraints', () => {
  test.each(CHECKS)('$constraint in the Drizzle table definition lists the same members', ({ constraint, table, members }) => {
    // Arrange
    const declared = getTableConfig(table).checks.find((candidate) => candidate.name === constraint)

    // Act
    const text = declared === undefined ? '' : new PgDialect().sqlToQuery(declared.value).sql

    // Assert
    expect(declared).toBeDefined()
    expect([...membersOf(text)].sort()).toEqual([...members].sort())
  })
})
