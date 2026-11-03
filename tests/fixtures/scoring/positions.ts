import type { ScoreInput } from '../../../src/entities/scoring.ts'
import type { ScoreResult } from '../../../src/scoring/score-against-set.ts'

export type FixturePosition = {
  name: string
  input: ScoreInput
  expected: ScoreResult
}

// Every company, requirement and number below is invented. Coverages are multiples of 0.25 and
// weights are small whole numbers, so each expected value is exact in binary floating point.

const gate = (key: string, label: string) => ({
  key,
  layerKey: 'basics',
  kind: 'gate' as const,
  weight: null,
  label,
})

const soft = (key: string, weight: number | null, label: string) => ({
  key,
  layerKey: 'craft',
  kind: 'soft' as const,
  weight,
  label,
})

const rating = (requirementKey: string, coverage: number | null) => ({
  requirementKey,
  coverage,
  confidence: 'supported' as const,
})

export const FIXTURE_POSITIONS: readonly FixturePosition[] = [
  {
    name: 'Acme Widgets, a clear apply',
    input: {
      requirements: [
        gate('location', 'Works from an allowed location'),
        soft('stack', 2, 'Uses a familiar stack'),
        soft('scope', 1, 'Owns a meaningful scope'),
        soft('mentoring', 1, 'Has people to learn from'),
      ],
      ratings: [
        rating('location', 1),
        rating('stack', 1),
        rating('scope', 0.75),
        rating('mentoring', 0.5),
      ],
      detours: [],
      penalties: [],
      applyThreshold: 0.7,
    },
    // (2 * 1 + 0.75 + 0.5) / 4
    expected: {
      overall: 0.8125,
      floor: 0.8125,
      ceiling: 0.8125,
      limiterKey: 'mentoring',
      limiterCoverage: 0.5,
      limiterIsUnknown: false,
      runnerUpKey: 'scope',
      recommendApply: true,
    },
  },
  {
    name: 'Globex Sample Works, a clear skip',
    input: {
      requirements: [
        gate('location', 'Works from an allowed location'),
        soft('stack', 2, 'Uses a familiar stack'),
        soft('scope', 1, 'Owns a meaningful scope'),
        soft('mentoring', 1, 'Has people to learn from'),
      ],
      ratings: [
        rating('location', 1),
        rating('stack', 0.25),
        rating('scope', 0.5),
        rating('mentoring', 0.75),
      ],
      detours: [],
      penalties: [],
      applyThreshold: 0.7,
    },
    // (2 * 0.25 + 0.5 + 0.75) / 4
    expected: {
      overall: 0.4375,
      floor: 0.4375,
      ceiling: 0.4375,
      limiterKey: 'stack',
      limiterCoverage: 0.25,
      limiterIsUnknown: false,
      runnerUpKey: 'scope',
      recommendApply: false,
    },
  },
  {
    name: 'Initech Example, a tie between two limiters',
    input: {
      requirements: [
        soft('stack', 2, 'Uses a familiar stack'),
        soft('scope', 1, 'Owns a meaningful scope'),
        soft('mentoring', 1, 'Has people to learn from'),
      ],
      ratings: [rating('stack', 1), rating('scope', 0.25), rating('mentoring', 0.25)],
      detours: [],
      penalties: [],
      applyThreshold: 0.5,
    },
    // (2 * 1 + 0.25 + 0.25) / 4. The tie at 0.25 falls back to the key order.
    expected: {
      overall: 0.625,
      floor: 0.625,
      ceiling: 0.625,
      limiterKey: 'mentoring',
      limiterCoverage: 0.25,
      limiterIsUnknown: false,
      runnerUpKey: 'scope',
      recommendApply: true,
    },
  },
  {
    name: 'Umbrella Demo Labs, lifted by a detour',
    input: {
      requirements: [
        gate('location', 'Works from an allowed location'),
        soft('sector', 2, 'Has experience in the sector'),
        soft('stack', 2, 'Uses a familiar stack'),
      ],
      ratings: [rating('location', 1), rating('sector', 0), rating('stack', 0.5)],
      // A neighbouring sector counts at three quarters of its strength.
      detours: [
        { requirementKey: 'sector', label: 'Adjacent sector', discount: 0.25, coverage: 1 },
      ],
      penalties: [],
      applyThreshold: 0.6,
    },
    // sector 1 * (1 - 0.25) = 0.75, so (2 * 0.75 + 2 * 0.5) / 4. Without the detour it is 0.25.
    expected: {
      overall: 0.625,
      floor: 0.625,
      ceiling: 0.625,
      limiterKey: 'stack',
      limiterCoverage: 0.5,
      limiterIsUnknown: false,
      runnerUpKey: 'sector',
      recommendApply: true,
    },
  },
  {
    name: 'Hooli Placeholder, blocked by an unrated gate',
    input: {
      requirements: [
        gate('authorisation', 'Allowed to work in the country'),
        soft('stack', 1, 'Uses a familiar stack'),
        soft('scope', 1, 'Owns a meaningful scope'),
      ],
      // The gate has no rating row at all: nobody has checked it yet.
      ratings: [rating('stack', 1), rating('scope', 0.75)],
      detours: [],
      penalties: [],
      applyThreshold: 0.7,
    },
    // The number clears the threshold; the unchecked gate is what stops the recommendation.
    expected: {
      overall: 0.875,
      floor: 0.875,
      ceiling: 0.875,
      limiterKey: 'authorisation',
      limiterCoverage: null,
      limiterIsUnknown: true,
      runnerUpKey: 'scope',
      recommendApply: false,
    },
  },
  {
    name: 'Quillon Placeholder Starter Pack, every weight null',
    input: {
      requirements: [
        gate('location', 'Works from an allowed location'),
        soft('stack', null, 'Uses a familiar stack'),
        soft('scope', null, 'Owns a meaningful scope'),
      ],
      ratings: [rating('location', 1), rating('stack', 0.5), rating('scope', 0.25)],
      detours: [],
      penalties: [],
      applyThreshold: 0.5,
    },
    // No weights to normalise against, so there is no number; the limiter is still named.
    expected: {
      overall: null,
      floor: null,
      ceiling: null,
      limiterKey: 'scope',
      limiterCoverage: 0.25,
      limiterIsUnknown: false,
      runnerUpKey: 'stack',
      recommendApply: false,
    },
  },
]
