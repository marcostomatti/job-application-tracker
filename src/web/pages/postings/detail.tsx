import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

import { DEFAULT_ASK_FLOOR } from '../../../stats/bands.ts'
import {
  data,
  type PostingDetail as PostingDetailData,
  type PostingTextState,
  type RecommendationDisplay,
  type RequirementRow,
  type StageHistoryRow,
  type StageRegistryRow,
} from '../../data.ts'
import { PostingFullText } from './detail-fulltext.tsx'
import { dispositionLabel, formatDay, latestScore, locationLine, postingLink } from './detail-labels.ts'
import { QuestionList } from './detail-questions.tsx'
import { RecommendationSummary, ScoreBreakdown } from './detail-score.tsx'
import { CurrentStage, StageForm, StageTimeline, type StageEventDraft } from './detail-stages.tsx'
import { DEFAULT_DISPLAY } from './recommendation.ts'

const TITLE_ID = 'posting-detail-title'

export interface DetailHandlers {
  readonly onRecordStage: (draft: StageEventDraft) => Promise<void>
  readonly onAddQuestion: (question: string) => Promise<void>
  readonly onAnswerQuestion: (questionId: number, answer: string) => Promise<void>
}

export interface PostingDetailViewProps extends DetailHandlers {
  readonly detail: PostingDetailData
  /** null when the history route could not be read. */
  readonly history: readonly StageHistoryRow[] | null
  readonly stages: readonly StageRegistryRow[]
  /** The latest score's set requirements; null while loading or when they could not be read. */
  readonly requirements: readonly RequirementRow[] | null
  readonly askFloor: number
  /** The Settings display choice; the panel shows both recommendations either way. */
  readonly display?: RecommendationDisplay
  readonly error: string | null
  /** The full posting from the notebook; the section is left out when this is not given. */
  readonly postingText?: PostingTextState
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="pd-section">
      <h3>{title}</h3>
      {children}
    </section>
  )
}

/** The stored summary's stack, which is JSON with no CHECK on its shape: only strings are shown. */
function stackTags(stack: unknown): string[] {
  return Array.isArray(stack) ? stack.filter((tag): tag is string => typeof tag === 'string' && tag.trim() !== '') : []
}

function Facts({ detail }: { detail: PostingDetailData }) {
  const { posting, references } = detail
  const facts: [string, string | null][] = [
    ['Work format', references.workFormat?.label ?? null],
    ['Seniority', references.seniority?.label ?? null],
    ['Apply route', references.applyRoute?.label ?? null],
    ['Location', locationLine(posting.city, posting.country)],
    ['Salary', posting.salaryRaw],
    ['Seen', formatDay(posting.seenAt)],
    ['Deadline', posting.deadline === null ? null : formatDay(posting.deadline)],
  ]
  return (
    <dl className="facts pd-facts">
      {facts.map(([label, value]) => (
        <div key={label} className="pd-fact">
          <dt>{label}</dt>
          <dd>{value ?? <span className="muted">not recorded</span>}</dd>
        </div>
      ))}
    </dl>
  )
}

function Summary({ summary }: { summary: PostingDetailData['summary'] }) {
  if (summary === null) return <p className="muted">No summary written yet.</p>
  const tags = stackTags(summary.stack)
  return (
    <div className="stack">
      <p className="pd-prose">{summary.condensed}</p>
      {summary.description !== null && <p className="pd-prose muted">{summary.description}</p>}
      {(summary.industry !== null || tags.length > 0) && (
        <div className="pd-tags">
          {summary.industry !== null && <span className="pd-chip">{summary.industry}</span>}
          {tags.map((tag) => (
            <span key={tag} className="pd-tag">
              {tag}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function Dispositions({ dispositions }: { dispositions: PostingDetailData['dispositions'] }) {
  if (dispositions.length === 0) return <p className="muted">Neither set aside nor rejected.</p>
  return (
    <ul className="pd-list">
      {dispositions.map(({ disposition, reasonLabel }) => (
        <li key={disposition.id}>
          <span className={`pd-chip pd-disposition-${disposition.kind}`}>{dispositionLabel(disposition.kind)}</span>{' '}
          {reasonLabel ?? <span className="muted">no reason recorded</span>}
          <span className="muted"> · {formatDay(disposition.notedAt)}</span>
          {disposition.note !== null && <p className="pd-note">{disposition.note}</p>}
        </li>
      ))}
    </ul>
  )
}

function Origins({ origins }: { origins: PostingDetailData['origins'] }) {
  if (origins.length === 0) return <p className="muted">No origin recorded.</p>
  return (
    <ul className="pd-list">
      {origins.map(({ origin, routeLabel }, index) => (
        <li key={origin.id}>
          <strong>{routeLabel ?? 'Unnamed route'}</strong>
          <span className="muted"> · {formatDay(origin.touchedOn)}</span>
          {index === 0 && <span className="pd-small muted"> · first touch</span>}
          {origin.note !== null && <p className="pd-note">{origin.note}</p>}
        </li>
      ))}
    </ul>
  )
}

/**
 * The detail panel for one loaded posting. Pure over its props apart from moving focus in on
 * mount, so a test can render it with no server.
 */
export function PostingDetailView(props: PostingDetailViewProps & { onClose: () => void }) {
  const { detail, history, stages, requirements, askFloor, error, onClose, display = DEFAULT_DISPLAY } = props
  const { posting, company } = detail
  const link = postingLink(posting, detail.summary?.extra)
  const score = latestScore(detail.scores)

  return (
    <>
      <header className="pd-head">
        <div>
          <p className="eyebrow">{company.name}</p>
          <h2 id={TITLE_ID}>{posting.roleTitle}</h2>
          {link !== null && (
            <a className="pd-link" href={link.href} target="_blank" rel="noreferrer">
              {link.label}
            </a>
          )}
        </div>
        <button type="button" className="button ghost pd-close" onClick={onClose} aria-label="Close posting detail">
          ×
        </button>
      </header>

      {error !== null && (
        <p className="error pd-error" role="alert">
          {error}
        </p>
      )}

      <Facts detail={detail} />
      <Section title="Summary">
        <Summary summary={detail.summary} />
      </Section>
      {props.postingText !== undefined && (
        <Section title="Full posting">
          <PostingFullText state={props.postingText} />
        </Section>
      )}
      <Section title="Stage">
        <CurrentStage latest={detail.latestStage} />
        <StageTimeline history={history} />
        <StageForm stages={stages} onRecord={props.onRecordStage} />
      </Section>
      <Section title="Recommendation">
        <RecommendationSummary recommendation={detail.recommendation} display={display} />
      </Section>
      <Section title="Score">
        <ScoreBreakdown score={score} otherSets={Math.max(0, detail.scores.length - 1)} requirements={requirements} askFloor={askFloor} />
      </Section>
      <Section title="Dispositions">
        <Dispositions dispositions={detail.dispositions} />
      </Section>
      <Section title="Origins">
        <Origins origins={detail.origins} />
      </Section>
      <Section title="Recruiter questions">
        <QuestionList questions={detail.questions} onAdd={props.onAddQuestion} onAnswer={props.onAnswerQuestion} />
      </Section>
    </>
  )
}

/** The dialog shell: a backdrop, the panel, Escape to close, and focus moved in when it opens. */
function DetailShell({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    panel.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      previous?.focus()
    }
  }, [onClose])

  return (
    <div className="pd-backdrop" onClick={(event) => event.target === event.currentTarget && onClose()}>
      <div ref={panel} className="pd-panel" role="dialog" aria-modal="true" aria-labelledby={TITLE_ID} tabIndex={-1}>
        {children}
      </div>
    </div>
  )
}

const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

interface Loaded {
  readonly detail: PostingDetailData
  readonly history: readonly StageHistoryRow[] | null
}

async function loadPosting(postingId: number): Promise<Loaded> {
  const [detail, history] = await Promise.all([data.posting(postingId), data.stageHistory(postingId).catch(() => null)])
  return { detail, history }
}

/** The posting detail panel: loads one posting, shows it, and writes stage events and questions. */
export interface PostingDetailProps {
  readonly postingId: number
  /** The Settings display choice, read once by the page. */
  readonly display?: RecommendationDisplay
  /** The configured ask floor, read once by the page; the default until it lands. */
  readonly askFloor?: number
  readonly onClose: () => void
  readonly onChanged: () => void
}

export function PostingDetail({ postingId, display = DEFAULT_DISPLAY, askFloor = DEFAULT_ASK_FLOOR, onClose, onChanged }: PostingDetailProps) {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [writeError, setWriteError] = useState<string | null>(null)
  const [stages, setStages] = useState<readonly StageRegistryRow[]>([])
  const [requirements, setRequirements] = useState<readonly RequirementRow[] | null>(null)
  const [postingText, setPostingText] = useState<PostingTextState>({ status: 'loading' })

  useEffect(() => {
    let live = true
    setLoaded(null)
    setLoadError(null)
    setWriteError(null)
    loadPosting(postingId).then(
      (next) => live && setLoaded(next),
      (cause: unknown) => live && setLoadError(messageOf(cause)),
    )
    return () => {
      live = false
    }
  }, [postingId])

  useEffect(() => {
    let live = true
    setPostingText({ status: 'loading' })
    data.postingText(postingId).then(
      (value) => live && setPostingText({ status: 'ready', value }),
      (cause: unknown) => live && setPostingText({ status: 'error', message: messageOf(cause) }),
    )
    return () => {
      live = false
    }
  }, [postingId])

  useEffect(() => {
    let live = true
    data.stages().then(
      (rows) => live && setStages(rows),
      () => live && setStages([]),
    )
    return () => {
      live = false
    }
  }, [])

  const setId = loaded === null ? null : (latestScore(loaded.detail.scores)?.score.criteriaSetId ?? null)
  useEffect(() => {
    if (setId === null) return
    let live = true
    setRequirements(null)
    data.requirements(setId).then(
      (rows) => live && setRequirements(rows),
      () => live && setRequirements(null),
    )
    return () => {
      live = false
    }
  }, [setId])

  /** Runs one write, reloads the posting, and tells the page; a failed write is shown and rethrown so the form keeps its text. */
  const write = useCallback(
    async (run: () => Promise<unknown>) => {
      setWriteError(null)
      try {
        await run()
      } catch (cause) {
        setWriteError(messageOf(cause))
        throw cause
      }
      onChanged()
      try {
        setLoaded(await loadPosting(postingId))
      } catch (cause) {
        setWriteError(`Saved, but the posting could not be reloaded: ${messageOf(cause)}`)
      }
    },
    [postingId, onChanged],
  )

  const handlers: DetailHandlers = {
    onRecordStage: (draft) => write(() => data.appendStage(postingId, draft)),
    onAddQuestion: (question) => write(() => data.addQuestion(postingId, question)),
    onAnswerQuestion: (questionId, answer) => write(() => data.answerQuestion(questionId, answer)),
  }

  return (
    <DetailShell onClose={onClose}>
      {loaded === null ? (
        <>
          <header className="pd-head">
            <h2 id={TITLE_ID}>{loadError === null ? 'Loading posting…' : 'Posting could not be read'}</h2>
            <button type="button" className="button ghost pd-close" onClick={onClose} aria-label="Close posting detail">
              ×
            </button>
          </header>
          {loadError !== null && (
            <p className="error" role="alert">
              {loadError}
            </p>
          )}
        </>
      ) : (
        <PostingDetailView
          detail={loaded.detail}
          history={loaded.history}
          stages={stages}
          postingText={postingText}
          requirements={requirements}
          askFloor={askFloor}
          display={display}
          error={writeError}
          onClose={onClose}
          {...handlers}
        />
      )}
    </DetailShell>
  )
}
