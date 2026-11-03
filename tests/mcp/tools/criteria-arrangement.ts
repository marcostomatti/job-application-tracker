import { eq } from 'drizzle-orm'

import type { DrizzleClient } from '../../../src/data/client.ts'
import { criteriaSet, insertCriteriaSet, requirement } from '../../../src/data/schema/criteria.ts'
import { idOf } from './harness.ts'

const ANCHORS = { '0': 'nothing', '0.5': 'some', '1': 'everything' }

/** A criteria set with a 0.5 bar and one soft requirement, keyed `skill`, weighted 1. */
export async function arrangeSet(db: DrizzleClient, name: string): Promise<{ setId: number; requirementId: number }> {
  const set = await insertCriteriaSet(db, { name, applyThreshold: 0.5 })
  const rows = await db
    .insert(requirement)
    .values({ criteriaSetId: set.id, key: 'skill', label: 'Skill', kind: 'soft', weight: 1, anchors: ANCHORS })
    .returning()
  return { setId: set.id, requirementId: idOf(rows) }
}

/** Archives a set the way a user would, which no tool offers: criteria sets have no archive verb. */
export async function archiveCriteriaSetForTest(db: DrizzleClient, setId: number): Promise<void> {
  await db.update(criteriaSet).set({ archivedAt: new Date() }).where(eq(criteriaSet.id, setId))
}
