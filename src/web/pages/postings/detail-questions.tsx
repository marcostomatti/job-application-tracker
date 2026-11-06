import { useState, type FormEvent } from 'react'

import type { PostingQuestion } from '../../data.ts'
import { formatDay, trimmedOrUndefined } from './detail-labels.ts'

/** The answer box under one open question. It reports the text; the panel does the write. */
function AnswerBox({ question, onAnswer }: { question: PostingQuestion; onAnswer: (questionId: number, answer: string) => Promise<void> }) {
  const [answer, setAnswer] = useState('')
  const [busy, setBusy] = useState(false)
  const inputId = `pd-answer-${question.id}`

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const text = trimmedOrUndefined(answer)
    if (text === undefined) return
    setBusy(true)
    try {
      await onAnswer(question.id, text)
      setAnswer('')
    } catch {
      // The panel shows the failure above; the text stays so it can be sent again.
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="pd-inline" onSubmit={submit}>
      <label className="pd-sr" htmlFor={inputId}>
        Answer to: {question.question}
      </label>
      <input id={inputId} className="pd-input" type="text" value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder="Answer" />
      <button type="submit" className="button" disabled={busy || answer.trim() === ''}>
        Save
      </button>
    </form>
  )
}

/** The recruiter questions: answered ones with their answer, open ones with an answer box, then an "add question" input. */
export function QuestionList({
  questions,
  onAdd,
  onAnswer,
}: {
  questions: readonly PostingQuestion[]
  onAdd: (question: string) => Promise<void>
  onAnswer: (questionId: number, answer: string) => Promise<void>
}) {
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const text = trimmedOrUndefined(draft)
    if (text === undefined) return
    setBusy(true)
    try {
      await onAdd(text)
      setDraft('')
    } catch {
      // The panel shows the failure above; the text stays so it can be sent again.
    } finally {
      setBusy(false)
    }
  }

  const open = questions.filter((question) => question.answer === null).length

  return (
    <div className="stack">
      {questions.length === 0 ? (
        <p className="muted">No questions yet.</p>
      ) : (
        <>
          <p className="muted pd-small">
            {open} open of {questions.length}
          </p>
          <ul className="pd-questions">
            {questions.map((question) => (
              <li key={question.id} className={question.answer === null ? 'open' : 'answered'}>
                <p className="pd-question">{question.question}</p>
                {question.answer === null ? (
                  <AnswerBox question={question} onAnswer={onAnswer} />
                ) : (
                  <p className="pd-answer">
                    {question.answer} <span className="muted">· {formatDay(question.answeredAt)}</span>
                  </p>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      <form className="pd-inline" onSubmit={add}>
        <label className="pd-sr" htmlFor="pd-new-question">
          New question
        </label>
        <input
          id="pd-new-question"
          className="pd-input"
          type="text"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Add a question for the recruiter"
        />
        <button type="submit" className="button" disabled={busy || draft.trim() === ''}>
          Add question
        </button>
      </form>
    </div>
  )
}
