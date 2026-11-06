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

  test('a gate rated 0 reads as blocking and puts the posting in skip', () => {
    const html = render({ detail: detailFixture({ remoteCoverage: 0 }) })
    expect(html).toContain('blocks')
    expect(html).toContain('pd-band-skip')
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
    const detail = { ...detailFixture(), summary: null, latestStage: null, scores: [], dispositions: [], origins: [], questions: [] }
    const html = render({ detail, history: null, stages: [] })
    for (const line of ['No summary written yet.', 'No stage recorded yet.', 'The stage history could not be read.', 'The stage registry is empty', 'no score recorded yet', 'Neither set aside nor rejected.', 'No origin recorded.', 'No questions yet.']) {
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
