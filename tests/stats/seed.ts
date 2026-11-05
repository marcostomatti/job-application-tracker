import type { Db } from '../../src/data/repositories/db.ts'
import { criteriaSet, detour, requirement } from '../../src/data/schema/criteria.ts'
import { postingStageEvent } from '../../src/data/schema/dispositions.ts'
import { company, posting, postingSummary } from '../../src/data/schema/postings.ts'
import { origin } from '../../src/data/schema/provenance.ts'
import { phase, route, seniority, stage } from '../../src/data/schema/registries.ts'
import { postingRating, postingRatingDetour, postingScore } from '../../src/data/schema/scores.ts'

/** What the seed made, by role, so a test can assert against it. */
export interface StatsSeed {
  readonly setId: number
  readonly otherSetId: number
  readonly postingIds: readonly number[]
}

const ANCHORS = { 0: 'none', 1: 'full' }

async function one<T>(rows: Promise<T[]>): Promise<T> {
  const [row] = await rows
  if (!row) throw new Error('the seed insert returned no row')
  return row
}

/** A posting picked from a small made-up market: every name here is generic and invented. */
interface ExamplePosting {
  readonly role: string
  readonly source: 'Job board' | 'Referral' | null
  readonly overall: number | null
  readonly recommend?: boolean
  readonly gate: number | null
  readonly fit: number | null
  readonly tools: number | null
  readonly detourTools?: number
  /** Scored, but with nothing weighted rated: an overall of null. */
  readonly withoutOverall?: boolean
  readonly stage: 'saved' | 'applied' | 'interview' | null
  readonly seniority: 'Junior' | 'Mid' | 'Senior' | null
  readonly summary: { industry: string | null; stack: string[]; years?: number; text: string } | null
}

const EXAMPLES: readonly ExamplePosting[] = [
  { role: 'Platform engineer', source: 'Job board', overall: 0.82, recommend: true, gate: 1, fit: 0.9, tools: 0.8, stage: 'applied', seniority: 'Senior', summary: { industry: 'Logistics', stack: ['TypeScript', 'Postgres'], years: 6, text: 'Kubernetes platform, Terraform modules, on-call rotation.' } },
  { role: 'Backend engineer', source: 'Job board', overall: 0.74, recommend: true, gate: 1, fit: 0.7, tools: 0.9, stage: 'interview', seniority: 'Mid', summary: { industry: 'Logistics', stack: ['Go', 'Postgres'], years: 4, text: 'Event streaming with Kafka; Kubernetes deployments.' } },
  { role: 'Data engineer', source: 'Referral', overall: 0.62, gate: 1, fit: 0.5, tools: 0.7, stage: 'saved', seniority: 'Mid', summary: { industry: 'Retail', stack: ['Python', 'dbt'], years: 3, text: 'Batch pipelines in Airflow, dbt models, Terraform.' } },
  { role: 'Full-stack engineer', source: 'Job board', overall: 0.55, gate: 1, fit: 0.4, tools: 0.6, stage: null, seniority: 'Junior', summary: { industry: null, stack: ['TypeScript', 'React'], text: 'React front end and Node services on Kubernetes.' } },
  { role: 'Site reliability engineer', source: 'Job board', overall: 0.78, gate: 0, fit: 0.8, tools: 0.7, stage: null, seniority: 'Senior', summary: { industry: 'Finance', stack: ['Go', 'Terraform'], years: 8, text: 'Incident response, Terraform, Kafka clusters.' } },
  { role: 'Mobile engineer', source: 'Referral', overall: 0.3, gate: 1, fit: 0.1, tools: 0, stage: null, seniority: 'Mid', summary: null },
  { role: 'Frontend engineer', source: null, overall: 0.45, gate: 1, fit: 0.3, tools: null, detourTools: 0.6, stage: null, seniority: null, summary: { industry: 'Retail', stack: ['react'], text: 'Design systems in React.' } },
  { role: 'Solutions engineer', source: 'Job board', overall: null, withoutOverall: true, gate: null, fit: null, tools: null, stage: null, seniority: null, summary: null },
  { role: 'Support engineer', source: null, overall: -1, gate: null, fit: null, tools: null, stage: 'saved', seniority: 'Junior', summary: null },
]

/**
 * A small made-up market for the stats tests and the browser preview: two criteria sets, a gate
 * and two soft requirements, nine postings across two sources and three stages, summaries with
 * and without an industry, stack and years, and scores against one set (one posting rescored,
 * one gate-blocked, one scored with no overall, one unscored). A posting with `overall: -1` is
 * scored only against the other set, so its score must never reach a read of the first.
 */
export async function seedStatsExample(db: Db): Promise<StatsSeed> {
  const set = await one(db.insert(criteriaSet).values({ name: 'Example rubric', version: 1, applyThreshold: 0.7, isDefault: true }).returning())
  const other = await one(db.insert(criteriaSet).values({ name: 'Example rubric', version: 2, applyThreshold: 0.5 }).returning())
  const gate = await one(db.insert(requirement).values({ criteriaSetId: set.id, key: 'location', label: 'Location works', kind: 'gate', anchors: ANCHORS, sort: 0 }).returning())
  const fit = await one(db.insert(requirement).values({ criteriaSetId: set.id, key: 'domain', label: 'Domain fit', kind: 'soft', weight: 2, anchors: ANCHORS, sort: 1 }).returning())
  const tools = await one(db.insert(requirement).values({ criteriaSetId: set.id, key: 'tools', label: 'Tooling match', kind: 'soft', weight: 1, anchors: ANCHORS, sort: 2 }).returning())
  const toolsDetour = await one(db.insert(detour).values({ requirementId: tools.id, label: 'Adjacent tool', discount: 0.5 }).returning())
  const otherSoft = await one(db.insert(requirement).values({ criteriaSetId: other.id, key: 'domain', label: 'Domain fit', kind: 'soft', weight: 1, anchors: ANCHORS }).returning())

  const routes = {
    'Job board': (await one(db.insert(route).values({ label: 'Job board' }).returning())).id,
    Referral: (await one(db.insert(route).values({ label: 'Referral' }).returning())).id,
  }
  const pipeline = await one(db.insert(phase).values({ key: 'pipeline', label: 'Pipeline', sort: 1 }).returning())
  const active = await one(db.insert(phase).values({ key: 'active', label: 'Active', sort: 2 }).returning())
  const stages = {
    saved: (await one(db.insert(stage).values({ key: 'saved', label: 'Saved', phaseId: pipeline.id, sort: 1 }).returning())).id,
    applied: (await one(db.insert(stage).values({ key: 'applied', label: 'Applied', phaseId: active.id, sort: 1, isApplied: true }).returning())).id,
    interview: (await one(db.insert(stage).values({ key: 'interview', label: 'Interview', phaseId: active.id, sort: 2 }).returning())).id,
  }
  const seniorities = {
    Junior: (await one(db.insert(seniority).values({ label: 'Junior', sort: 1 }).returning())).id,
    Mid: (await one(db.insert(seniority).values({ label: 'Mid', sort: 2 }).returning())).id,
    Senior: (await one(db.insert(seniority).values({ label: 'Senior', sort: 3 }).returning())).id,
  }
  const employer = await one(db.insert(company).values({ name: 'Example Co', nameNorm: 'example co' }).returning())

  const postingIds: number[] = []
  for (const [index, example] of EXAMPLES.entries()) {
    const row = await one(
      db
        .insert(posting)
        .values({
          postingKey: `example-${index}`,
          companyId: employer.id,
          roleTitle: example.role,
          roleNorm: example.role.toLowerCase(),
          seniorityId: example.seniority === null ? null : seniorities[example.seniority],
        })
        .returning(),
    )
    postingIds.push(row.id)
    if (example.source !== null) await db.insert(origin).values({ postingId: row.id, routeId: routes[example.source], touchedOn: '2026-01-05' })
    if (example.stage !== null) await db.insert(postingStageEvent).values({ postingId: row.id, stageId: stages[example.stage] })
    if (example.summary !== null) {
      await db.insert(postingSummary).values({
        postingId: row.id,
        industry: example.summary.industry,
        stack: example.summary.stack,
        extra: example.summary.years === undefined ? {} : { years_experience: example.summary.years },
        condensed: example.summary.text,
        sourceHash: `hash-${index}`,
      })
    }
    if (example.overall === -1) {
      const foreign = await one(db.insert(postingScore).values({ postingId: row.id, criteriaSetId: other.id, overall: 0.99, recommendApply: true }).returning())
      await db.insert(postingRating).values({ scoreId: foreign.id, criteriaSetId: other.id, requirementId: otherSoft.id, coverage: 0.99 })
      continue
    }
    if (example.withoutOverall) {
      await db.insert(postingScore).values({ postingId: row.id, criteriaSetId: set.id, overall: null })
      continue
    }
    // An older score that the latest must replace.
    if (index === 0) await db.insert(postingScore).values({ postingId: row.id, criteriaSetId: set.id, overall: 0.1, scoredAt: '2025-12-01' })
    const score = await one(
      db.insert(postingScore).values({ postingId: row.id, criteriaSetId: set.id, overall: example.overall, recommendApply: example.recommend ?? false }).returning(),
    )
    const ratings = [
      { requirementId: gate.id, coverage: example.gate },
      { requirementId: fit.id, coverage: example.fit },
      { requirementId: tools.id, coverage: example.tools },
    ].filter((entry) => entry.coverage !== null || entry.requirementId === tools.id)
    await db.insert(postingRating).values(ratings.map((entry) => ({ scoreId: score.id, criteriaSetId: set.id, ...entry })))
    if (example.detourTools !== undefined) {
      await db.insert(postingRatingDetour).values({ scoreId: score.id, requirementId: tools.id, detourId: toolsDetour.id, coverage: example.detourTools })
    }
  }
  return { setId: set.id, otherSetId: other.id, postingIds }
}
