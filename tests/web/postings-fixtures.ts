import type { AgentVerdict, PhaseRegistryRow, PostingListRow, Recommendation, RulesBand, StageRegistryRow } from '../../src/web/data.ts'

/** Invented rows for the postings page tests: no real employer, role or person. */

export const PHASES: PhaseRegistryRow[] = [
  { id: 2, key: 'applied', label: 'Applied', sort: 2, isShortlist: false, archivedAt: null },
  { id: 1, key: 'shortlist', label: 'Shortlist', sort: 1, isShortlist: true, archivedAt: null },
  { id: 3, key: 'old', label: 'Retired column', sort: 3, isShortlist: false, archivedAt: new Date('2026-01-01T00:00:00Z') },
]

export function stageIn(phaseId: number, id: number, label: string): StageRegistryRow {
  return { id, key: `stage-${id}`, label, phaseId, sort: id, isTerminal: false, isRepeatable: false, isTraction: false, isApplied: false, archivedAt: null }
}

interface RowInput {
  readonly id: number
  readonly company?: string
  readonly role?: string
  readonly phaseId?: number | null
  readonly stage?: string
  readonly overall?: number | null
  readonly scored?: boolean
  readonly recommendApply?: boolean
  readonly rank?: number | null
  readonly seenAt?: string
  readonly setAside?: boolean
  /** The server's rules band; by default what the rules give for the score at the default ask floor, gates open. */
  readonly rules?: RulesBand
  /** The agent's verdict; none by default. */
  readonly agent?: AgentVerdict | null
}

/** The rules band the server would send for an ungated score at the 0.5 ask floor. */
function rulesFor(scored: boolean, overall: number | null, recommendApply: boolean): RulesBand {
  if (!scored) return 'unscored'
  if (recommendApply) return 'apply'
  if (overall === null) return 'unscored'
  return overall < 0.5 ? 'skip' : 'ask'
}

export function recommendation(rules: RulesBand, agent: AgentVerdict | null = null): Recommendation {
  return { rules, agent, disagree: agent !== null && agent.band !== rules }
}

export function row(input: RowInput): PostingListRow {
  const phaseId = input.phaseId ?? null
  const phase = phaseId === null ? null : (PHASES.find((entry) => entry.id === phaseId) ?? null)
  const scored = input.scored ?? true
  const overall = input.overall === undefined ? 0.6 : input.overall
  return {
    posting: {
      id: input.id,
      postingKey: `key-${input.id}`,
      companyId: input.id,
      roleTitle: input.role ?? `Role ${input.id}`,
      roleNorm: (input.role ?? `role ${input.id}`).toLowerCase(),
      disambiguator: '',
      seenAt: input.seenAt ?? '2026-03-01',
      deadline: null,
      city: null,
      country: null,
      workFormatId: null,
      seniorityId: null,
      applyRouteId: null,
      salaryRaw: null,
      postingAgeRaw: null,
      applicantCountRaw: null,
      applyContact: null,
      priorityRank: input.rank ?? null,
      clientHidden: false,
      firstImportedAt: new Date('2026-03-01T09:00:00Z'),
      // JSON carries a timestamp as a string, which is what the page reads at run time.
      lastImportedAt: '2026-03-04T09:00:00Z' as unknown as Date,
    },
    company: { id: input.id, name: input.company ?? `Company ${input.id}`, nameNorm: `company ${input.id}`, nameUnresolved: false, createdAt: new Date('2026-01-01T00:00:00Z') },
    stage: phaseId === null ? null : stageIn(phaseId, 100 + input.id, input.stage ?? 'Waiting'),
    phase,
    score: scored
      ? {
          id: 1000 + input.id,
          postingId: input.id,
          criteriaSetId: 1,
          scoredAt: '2026-03-02',
          overall,
          limiterRequirementId: null,
          limiterCoverage: null,
          limiterIsUnknown: false,
          runnerUpRequirementId: null,
          floor: null,
          ceiling: null,
          recommendApply: input.recommendApply ?? false,
          isRescore: false,
          note: null,
          agentVerdict: input.agent?.band ?? null,
          agentReason: input.agent?.reason ?? null,
        }
      : null,
    setAside: input.setAside ?? false,
    recommendation: recommendation(input.rules ?? rulesFor(scored, overall, input.recommendApply ?? false), input.agent ?? null),
  }
}
