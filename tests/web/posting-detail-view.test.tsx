import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import { PostingDetailView, type PostingDetailViewProps } from '../../src/web/pages/postings/detail.tsx'
import { detailFixture, HISTORY, REQUIREMENTS, STAGES } from './posting-detail-fixtures.ts'

const noop = async (): Promise<void> => undefined

function render(overrides: Partial<PostingDetailViewProps> = {}): string {
  return renderToStaticMarkup(
    <PostingDetailView
      detail={detailFixture()}
      history={HISTORY}
      stages={STAGES}
      requirements={REQUIREMENTS}
      askFloor={0.5}
      error={null}
      onClose={() => undefined}
      onRecordStage={noop}
      onAddQuestion={noop}
      onAnswerQuestion={noop}
      {...overrides}
    />,
  )
}

describe('PostingDetailView', () => {
  test('shows the role, company, an inert posting link and the facts', () => {
    const html = render()

    expect(html).toContain('id="posting-detail-title"')
    expect(html).toContain('Platform Engineer')
    expect(html).toContain('Example Widgets')
    expect(html).toContain('href="https://jobs.example.test/roles/42"')
    expect(html).toContain('rel="noreferrer"')
    for (const fact of ['Remote', 'Senior', 'Company site', 'Sampleton']) expect(html).toContain(fact)
    expect(html).toContain('aria-label="Close posting detail"')
  })

  test('shows the summary, with only string stack tags', () => {
    const html = render()
    expect(html).toContain('Builds the internal deploy platform.')
    expect(html).toContain('Logistics')
    expect(html).toContain('>Postgres<')
    expect(html).not.toContain('>7<')
  })

  test('shows the current stage, the history newest first, and the stage form in registry order', () => {
    const html = render()
    expect(html).toContain('since 2026-10-05')
    const timeline = html.slice(html.indexOf('aria-label="Stage history"'))
    expect(timeline.indexOf('Applied')).toBeLessThan(timeline.indexOf('Shortlisted'))
    expect(html).toContain('Looked promising')
    const form = html.slice(html.indexOf('aria-label="Record a stage"'))
    expect(form.indexOf('Shortlisted')).toBeLessThan(form.indexOf('Applied'))
    expect(form).toContain('type="date"')
  })

  test('shows the score with its band, per-requirement breakdown and penalties', () => {
    const html = render()
    expect(html).toContain('3.1 / 5 (62%)')
    expect(html).toContain('pd-band-ask')
    expect(html).toContain('Remote friendly')
    expect(html).toContain('passes')
    expect(html).toContain('50%')
    expect(html).toContain('Travel')
    expect(html).toContain('−0.05')
    expect(html).toContain('Long commute days')
  })

  test("shows both recommendations, the agent's reason, and says they disagree", () => {
    const html = render()
    const section = html.slice(html.indexOf('>Recommendation<'), html.indexOf('>Score<'))

    expect(section).toContain('pd-band-ask')
    expect(section).toContain('pd-band-skip')
    expect(section).toContain('The on-call load outweighs the domain fit.')
    expect(section).toContain('They disagree: the rules say Ask, the agent says Skip.')
  })

  test('with no agent verdict it says so, and under agent it says the rules band stands in', () => {
    const detail = detailFixture({ recommendation: { rules: 'ask', agent: null, disagree: false } })
    const both = render({ detail })
    const agent = render({ detail, display: 'agent' })

    expect(both).toContain('No verdict on this score.')
    expect(both).not.toContain('They disagree')
    expect(both).not.toContain('until the agent gives a verdict')
    expect(agent).toContain('until the agent gives a verdict')
  })

  test('a gate rated 0 reads as blocking and puts the posting in skip', () => {
    const html = render({ detail: detailFixture({ remoteCoverage: 0 }) })
    const score = html.slice(html.indexOf('>Score<'))
    expect(score).toContain('blocks')
    expect(score).toContain('pd-band-skip')
    expect(score).not.toContain('pd-band-ask')
  })

  test('shows dispositions, origins and the questions with one answer box per open question', () => {
    const html = render()
    expect(html).toContain('Set aside')
    expect(html).toContain('Too much on-call')
    expect(html).toContain('Job board')
    expect(html).toContain('first touch')
    expect(html).toContain('Yes, within the region.')
    expect(html).toContain('1 open of 2')
    expect(html.match(/id="pd-answer-/g)?.length).toBe(1)
    expect(html).toContain('id="pd-answer-2"')
    expect(html).toContain('Add question')
  })

  test('says what is missing rather than rendering blank', () => {
    const detail = { ...detailFixture({ recommendation: null }), summary: null, latestStage: null, scores: [], dispositions: [], origins: [], questions: [] }
    const html = render({ detail, history: null, stages: [] })
    for (const line of ['No summary written yet.', 'No stage recorded yet.', 'The stage history could not be read.', 'The stage registry is empty', 'no score recorded yet', 'No recommendation: the posting has no score yet.', 'Neither set aside nor rejected.', 'No origin recorded.', 'No questions yet.']) {
      expect(html).toContain(line)
    }
  })

  test('a write error is announced', () => {
    expect(render({ error: 'the server answered 500' })).toContain('role="alert"')
  })
})

describe('PostingDetail', () => {
  test('opens as a labelled modal dialog that can take focus, loading until the read lands', async () => {
    const { PostingDetail } = await import('../../src/web/pages/postings/detail.tsx')
    const html = renderToStaticMarkup(<PostingDetail postingId={42} onClose={() => undefined} onChanged={() => undefined} />)
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
    expect(html).toContain('aria-labelledby="posting-detail-title"')
    expect(html).toContain('tabindex="-1"')
    expect(html).toContain('Loading posting')
  })
})

describe('the full posting section', () => {
  const ready = (text: string | null, extra: Record<string, unknown> = {}) => ({
    status: 'ready' as const,
    value: { configured: true as const, postingKey: 'example/platform-engineer', copies: 1, complete: true, source: text === null ? null : { id: 'source:1', title: 'example/platform-engineer', created: '2026-11-10T09:00:00Z' }, text, totalChars: text?.length ?? 0, truncated: false, ...extra },
  })

  test('shows the stored text with where it came from', () => {
    const html = render({ postingText: ready('We build widgets.\nYou know TypeScript.') })

    expect(html).toContain('Full posting')
    expect(html).toContain('We build widgets.')
    expect(html).toContain('You know TypeScript.')
    expect(html).toContain('stored 2026-11-10')
  })

  test('says when there are several copies or the text was cut', () => {
    const html = render({ postingText: ready('text', { copies: 3, truncated: true, totalChars: 300000 }) })

    expect(html).toContain('newest of 3 copies')
    expect(html).toContain('cut at')
  })

  test('says what is missing: loading, no text stored, no notebook, or a notebook that failed', () => {
    expect(render({ postingText: { status: 'loading' } })).toContain('Loading the full posting')
    expect(render({ postingText: ready(null) })).toContain('No full text is stored in the notebook for this posting.')
    expect(render({ postingText: { status: 'ready', value: { configured: false } } })).toContain('No notebook is configured')
    expect(render({ postingText: { status: 'error', message: 'notebook unavailable' } })).toContain('notebook unavailable')
  })

  test('without the prop the section is not drawn', () => {
    expect(render()).not.toContain('Full posting')
  })
})
