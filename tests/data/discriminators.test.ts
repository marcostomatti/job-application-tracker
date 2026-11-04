import { afterAll, describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core'

import { closeDb, getDb } from '../../src/data/client.ts'
import { requirement } from '../../src/data/schema/criteria.ts'
import { positionRating } from '../../src/data/schema/scores.ts'
import { RATING_CONFIDENCES, REQUIREMENT_KINDS } from '../../src/schemas/discriminators.ts'

afterAll(closeDb)

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
  { constraint: 'position_rating_confidence_check', table: positionRating, members: RATING_CONFIDENCES },
] as const

/**
 * `gate|soft` and `supported|partial|unknown` are accepted by the zod schemas (which import one
 * constant each from `src/schemas/discriminators.ts`) and by a CHECK constraint, which is SQL
 * and cannot import anything. This is what ties the two: a member added to the constant and not
 * to the migration would be a 500 on every row of the new kind, and the reverse a database that
 * accepts what the API refuses.
 */
describe('structural discriminators match their CHECK constraints', () => {
  test.each(CHECKS)('$constraint lists exactly the members of the schema constant, in the migrated database', async ({ constraint, members }) => {
    // Arrange
    const db = getDb()

    // Act
    const rows = await db.execute<{ definition: string }>(sql`
      select pg_get_constraintdef(oid) as definition
      from pg_constraint
      where conname = ${constraint} and contype = 'c' and connamespace = 'public'::regnamespace
    `)

    // Assert: one constraint, and its members are the constant's, as sets and in size
    expect(rows).toHaveLength(1)
    const listed = membersOf(rows[0]?.definition ?? '')
    expect(listed.length).toBeGreaterThan(0)
    expect([...listed].sort()).toEqual([...members].sort())
  })

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
