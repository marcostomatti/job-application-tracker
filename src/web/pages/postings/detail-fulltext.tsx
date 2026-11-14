import type { PostingTextState } from '../../data.ts'
import { formatDay } from './detail-labels.ts'

/**
 * The posting's full text, read from the notebook copy titled with its posting key, so the user
 * can check the role against their own reading and not only against the score. The text is shown
 * as stored, as plain text: React escapes it, and nothing in it is followed or requested.
 */
export function PostingFullText({ state }: { state: PostingTextState }) {
  if (state.status === 'loading') return <p className="muted">Loading the full posting…</p>
  if (state.status === 'error') return <p className="error">The full posting could not be read: {state.message}</p>
  const found = state.value
  if (!found.configured) return <p className="muted">No notebook is configured, so the full posting is not stored here.</p>
  if (found.text === null) return <p className="muted">No full text is stored in the notebook for this posting.</p>
  const notes = [
    found.source?.created ? `stored ${formatDay(found.source.created)}` : null,
    found.copies > 1 ? `newest of ${found.copies} copies` : null,
    found.truncated ? `cut at ${found.text.length.toLocaleString()} of ${found.totalChars.toLocaleString()} characters` : null,
    found.complete ? null : 'the lookup stopped early, so a newer copy may exist',
  ].filter((note): note is string => note !== null)
  return (
    <>
      <p className="muted pd-fulltext-meta">From the notebook{notes.length === 0 ? '' : `, ${notes.join(', ')}`}.</p>
      <div className="pd-fulltext" tabIndex={0} aria-label="Full posting text">
        {found.text}
      </div>
    </>
  )
}
