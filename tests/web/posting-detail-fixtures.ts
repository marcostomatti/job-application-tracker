/** Invented fixtures for the posting detail tests: no real company, person or host. */
import type { PostingDetail, RequirementRow, StageHistoryRow, StageRegistryRow } from '../../src/web/data.ts'

const stage = (id: number, label: string, sort: number): StageRegistryRow =>
  ({ id, label, key: label.toLowerCase(), phaseId: 1, sort, isTerminal: false, isRepeatable: false, isTraction: false, isApplied: false, archivedAt: null }) as StageRegistryRow

export const STAGES: StageRegistryRow[] = [stage(2, 'Applied', 2), stage(1, 'Shortlisted', 1)]

export const REQUIREMENTS = [
  { id: 10, criteriaSetId: 3, layerId: null, key: 'remote', label: 'Remote friendly', kind: 'gate', weight: null, anchors: {}, sort: 0, layerLabel: null, detours: [] },
  { id: 11, criteriaSetId: 3, layerId: null, key: 'domain', label: 'Domain fit', kind: 'soft', weight: 2, anchors: {}, sort: 1, layerLabel: null, detours: [] },
] as unknown as RequirementRow[]

const rating = (requirementId: number, coverage: number | null, key: string, label: string) => ({
  rating: { scoreId: 7, criteriaSetId: 3, requirementId, coverage, confidence: 'supported', evidence: null },
  requirementKey: key,
  requirementLabel: label,
})

export function detailFixture(overrides: { remoteCoverage?: number | null } = {}): PostingDetail {
  return {
    posting: {
      id: 42,
      postingKey: 'https://jobs.example.test/roles/42',
      companyId: 5,
      roleTitle: 'Platform Engineer',
      roleNorm: 'platform engineer',
      disambiguator: '',
      seenAt: '2026-10-01',
      deadline: null,
      city: 'Sampleton',
      country: null,
      workFormatId: 1,
      seniorityId: 1,
      applyRouteId: 1,
      salaryRaw: null,
      postingAgeRaw: null,
      applicantCountRaw: null,
      applyContact: null,
      priorityRank: null,
      clientHidden: false,
      firstImportedAt: '2026-10-01T09:00:00.000Z',
      lastImportedAt: '2026-10-01T09:00:00.000Z',
    },
    company: { id: 5, name: 'Example Widgets', nameNorm: 'example widgets', nameUnresolved: false, createdAt: '2026-10-01T09:00:00.000Z' },
    references: {
      workFormat: { id: 1, label: 'Remote', key: 'remote', archivedAt: null },
      seniority: { id: 1, label: 'Senior', key: 'senior', sort: 3, archivedAt: null },
      applyRoute: { id: 1, label: 'Company site', key: 'site', archivedAt: null },
    },
    summary: {
      postingId: 42,
      stack: ['Go', 'Postgres', 7],
      description: null,
      industry: 'Logistics',
      condensed: 'Builds the internal deploy platform.',
      extra: {},
      sourceHash: 'hash-1',
      summarisedAt: '2026-10-02T09:00:00.000Z',
    },
    latestStage: {
      event: { id: 2, postingId: 42, stageId: 2, occurredAt: '2026-10-05T12:00:00.000Z', note: null },
      stage: STAGES[0],
      phase: { id: 1, label: 'Active', key: 'active', sort: 1, isShortlist: false, archivedAt: null },
    },
    scores: [
      {
        score: {
          id: 7,
          postingId: 42,
          criteriaSetId: 3,
          scoredAt: '2026-10-03',
          overall: 0.62,
          limiterRequirementId: 11,
          limiterCoverage: 0.5,
          limiterIsUnknown: false,
          runnerUpRequirementId: null,
          floor: null,
          ceiling: null,
          recommendApply: false,
          isRescore: false,
          note: null,
        },
        ratings: [rating(11, 0.5, 'domain', 'Domain fit'), rating(10, overrides.remoteCoverage === undefined ? 1 : overrides.remoteCoverage, 'remote', 'Remote friendly')],
        penalties: [{ penalty: { id: 1, scoreId: 7, penaltyKindId: 1, amount: -0.05, reason: 'Long commute days' }, kindLabel: 'Travel' }],
      },
    ],
    dispositions: [
      {
        disposition: { id: 1, postingId: 42, kind: 'set_aside', setAsideReasonId: 1, rejectionReasonId: null, notedAt: '2026-10-06T09:00:00.000Z', note: null },
        reasonLabel: 'Too much on-call',
      },
    ],
    origins: [
      {
        origin: { id: 1, postingId: 42, routeId: 1, touchedOn: '2026-09-30', recordedAt: '2026-10-01T09:00:00.000Z', note: null, searchRunId: null },
        routeLabel: 'Job board',
      },
    ],
    questions: [
      { id: 1, postingId: 42, question: 'Is the role fully remote?', answer: 'Yes, within the region.', answeredAt: '2026-10-04T09:00:00.000Z', createdAt: '2026-10-03T09:00:00.000Z' },
      { id: 2, postingId: 42, question: 'What is the on-call rota?', answer: null, answeredAt: null, createdAt: '2026-10-03T09:00:00.000Z' },
    ],
  } as unknown as PostingDetail
}

export const HISTORY: StageHistoryRow[] = [
  { event: { id: 1, postingId: 42, stageId: 1, occurredAt: '2026-10-02T12:00:00.000Z', note: 'Looked promising' }, stage: STAGES[1]! },
  { event: { id: 2, postingId: 42, stageId: 2, occurredAt: '2026-10-05T12:00:00.000Z', note: null }, stage: STAGES[0]! },
] as unknown as StageHistoryRow[]
