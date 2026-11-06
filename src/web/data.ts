/**
 * The contract between the postings, texts and criteria pages and the server. Every type is the
 * server's own (type-only imports, erased by the bundler), so a page and a route cannot drift.
 * Routes marked NEW are added by this branch; the rest exist on main.
 */
import type { CriteriaSetRow, RequirementRow } from '../data/repositories/criteria.ts'
import type { StageEvent } from '../data/repositories/dispositions.ts'
import type { PostingDetail, PostingListRow, Posting } from '../data/repositories/postings.ts'
import type { PostingQuestion } from '../data/repositories/questions.ts'
import type { RegistryRowOf } from '../data/repositories/registries.ts'
import type { ScoreRow } from '../data/repositories/scores.ts'
import type { TextAsset } from '../data/repositories/texts.ts'
import type { Scale } from '../scoring/scale.ts'
import { request } from './api.ts'

export type { CriteriaSetRow, PostingDetail, PostingListRow, PostingQuestion, RequirementRow, ScoreRow, StageEvent, TextAsset }

export type StageRegistryRow = RegistryRowOf<'stage'>
export type PhaseRegistryRow = RegistryRowOf<'phase'>

/** One event of a posting's stage history, oldest first, with the stage it names (null for a cleared stage). */
export interface StageHistoryRow {
  readonly event: StageEvent
  readonly stage: StageRegistryRow | null
}

export interface PostingListQuery {
  readonly phaseId?: number
  readonly criteriaSetId?: number
  readonly recommendApply?: boolean
  readonly setAside?: 'exclude' | 'include' | 'only'
  readonly scale?: Scale
  readonly limit?: number
  readonly offset?: number
}

function query(params: Record<string, string | number | boolean | undefined>): string {
  const entries = Object.entries(params).filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
  return entries.length === 0 ? '' : `?${new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString()}`
}

const id = (value: number): string => encodeURIComponent(String(value))

export const data = {
  postings: (q: PostingListQuery = {}): Promise<PostingListRow[]> => request('GET', `/api/postings${query({ ...q })}`),
  posting: (postingId: number, scale?: Scale): Promise<PostingDetail> =>
    request('GET', `/api/postings/${id(postingId)}${query({ scale })}`),
  /** Writes `priorityRank` (the board order) or any other editable field. */
  updatePosting: (postingId: number, patch: Record<string, unknown>): Promise<Posting> =>
    request('PATCH', `/api/postings/${id(postingId)}`, { patch }),

  /** NEW: GET /api/postings/:postingId/stages — the whole stage history, oldest first. */
  stageHistory: (postingId: number): Promise<StageHistoryRow[]> => request('GET', `/api/postings/${id(postingId)}/stages`),
  appendStage: (postingId: number, input: { stageId: number | null; occurredAt?: string; note?: string }): Promise<StageEvent> =>
    request('POST', `/api/postings/${id(postingId)}/stage`, input),

  /** NEW: POST /api/postings/:postingId/questions */
  addQuestion: (postingId: number, question: string): Promise<PostingQuestion> =>
    request('POST', `/api/postings/${id(postingId)}/questions`, { question }),
  /** NEW: PUT /api/questions/:questionId/answer */
  answerQuestion: (questionId: number, answer: string): Promise<PostingQuestion> =>
    request('PUT', `/api/questions/${id(questionId)}/answer`, { answer }),

  scoreHistory: (postingId: number, scale?: Scale): Promise<ScoreRow[]> =>
    request('GET', `/api/postings/${id(postingId)}/scores${query({ scale })}`),

  stages: (): Promise<StageRegistryRow[]> => request('GET', '/api/registries/stage'),
  phases: (): Promise<PhaseRegistryRow[]> => request('GET', '/api/registries/phase'),

  texts: (q: { postingId?: number; includeHistory?: boolean } = {}): Promise<TextAsset[]> => request('GET', `/api/texts${query({ ...q })}`),

  criteriaSets: (): Promise<CriteriaSetRow[]> => request('GET', '/api/criteria-sets'),
  /** GET /api/criteria-sets/:criteriaSetId/requirements */
  requirements: (criteriaSetId: number): Promise<RequirementRow[]> =>
    request('GET', `/api/criteria-sets/${id(criteriaSetId)}/requirements`),
}
