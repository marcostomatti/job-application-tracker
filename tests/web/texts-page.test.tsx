import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import type { TextAsset } from '../../src/web/data.ts'
import { TextsView } from '../../src/web/pages/texts.tsx'
import {
  ALL_TYPES,
  BODY_PREVIEW_LENGTH,
  filterTexts,
  groupTexts,
  NO_TYPE,
  preview,
  typeName,
  typeNamesOf,
  typeOptions,
} from '../../src/web/pages/texts-helpers.ts'

const noop = (): void => {}

const text = (overrides: Partial<TextAsset> & Pick<TextAsset, 'id' | 'label'>): TextAsset => ({
  textTypeId: null,
  body: 'Example body.',
  version: 1,
  createdAt: new Date('2026-03-04T10:00:00Z'),
  ...overrides,
})

const NEWEST: TextAsset[] = [
  text({ id: 3, label: 'Sample cover letter', textTypeId: 2, version: 2, body: 'Second wording of a sample letter.' }),
  text({ id: 4, label: 'Answer: why this team', textTypeId: 1, body: 'An invented form answer about tooling.' }),
  text({ id: 5, label: 'Untyped note', body: 'Line one.\n\n   Line two.' }),
]

/** Invented registry labels; type 1 is known, type 2 is not (archived, or never listed). */
const NAMES = typeNamesOf([{ id: 1, label: 'Form answer' }, { id: 3, label: 'Outreach' }])

const HISTORY: TextAsset[] = [...NEWEST, text({ id: 1, label: 'Sample cover letter', textTypeId: 2, version: 1, body: 'First wording, kept.' })]

describe('texts helpers', () => {
  test('preview flattens whitespace and cuts long bodies with an ellipsis', () => {
    expect(preview('Line one.\n\n   Line two.')).toBe('Line one. Line two.')
    const long = preview('x'.repeat(BODY_PREVIEW_LENGTH + 10))
    expect(long.length).toBe(BODY_PREVIEW_LENGTH + 1)
    expect(long.endsWith('…')).toBe(true)
  })

  test('groupTexts groups by label in label order, versions newest first', () => {
    const groups = groupTexts(HISTORY)

    expect(groups.map((group) => group.label)).toEqual(['Answer: why this team', 'Sample cover letter', 'Untyped note'])
    expect(groups[1]?.versions.map((version) => version.version)).toEqual([2, 1])
    expect(groups[1]?.newest.id).toBe(3)
  })

  test('filterTexts matches the label or any version body, case-insensitively', () => {
    const groups = groupTexts(HISTORY)

    expect(filterTexts(groups, { query: 'TOOLING', type: ALL_TYPES }).map((group) => group.label)).toEqual(['Answer: why this team'])
    expect(filterTexts(groups, { query: 'first wording', type: ALL_TYPES }).map((group) => group.label)).toEqual(['Sample cover letter'])
    expect(filterTexts(groups, { query: '  ', type: ALL_TYPES })).toHaveLength(3)
  })

  test('the type filter is judged on the newest version, untyped included', () => {
    const groups = groupTexts(HISTORY)

    expect(filterTexts(groups, { query: '', type: '2' }).map((group) => group.label)).toEqual(['Sample cover letter'])
    expect(filterTexts(groups, { query: '', type: NO_TYPE }).map((group) => group.label)).toEqual(['Untyped note'])
  })

  test('typeOptions lists typed ids in order, untyped last', () => {
    expect(typeOptions(groupTexts(NEWEST))).toEqual([
      { value: '1', label: 'Type 1' },
      { value: '2', label: 'Type 2' },
      { value: NO_TYPE, label: 'Untyped' },
    ])
    expect(typeName(null)).toBe('Untyped')
  })

  test('a known type prints its registry label, an unknown id falls back to Type N', () => {
    expect(typeName(1, NAMES)).toBe('Form answer')
    expect(typeName(2, NAMES)).toBe('Type 2')
    expect(typeName(null, NAMES)).toBe('Untyped')
  })

  test('with labels, the type options are sorted by the printed name, untyped still last', () => {
    expect(typeOptions(groupTexts(NEWEST), NAMES)).toEqual([
      { value: '1', label: 'Form answer' },
      { value: '2', label: 'Type 2' },
      { value: NO_TYPE, label: 'Untyped' },
    ])
  })
})

describe('TextsView', () => {
  test('lists one row per label with type, preview, version and date', () => {
    const html = renderToStaticMarkup(<TextsView texts={NEWEST} history={false} onHistoryChange={noop} />)

    expect(html).toContain('Sample cover letter')
    expect(html).toContain('Type 2')
    expect(html).toContain('Untyped')
    expect(html).toContain('Line one. Line two.')
    expect(html).toContain('v2')
    expect(html.match(/class="texts-row/g)?.length).toBe(3)
    expect(html).not.toContain('Full text:')
  })

  test('with type labels, rows and the filter show them, and an unknown id keeps Type N', () => {
    const html = renderToStaticMarkup(<TextsView texts={NEWEST} history={false} onHistoryChange={noop} typeNames={NAMES} />)

    expect(html).toContain('<span class="text-type">Form answer</span>')
    expect(html).toContain('<option value="1">Form answer</option>')
    expect(html).toContain('<span class="text-type">Type 2</span>')
    expect(html).not.toContain('Outreach')
  })

  test('an open row shows the whole body and a copy button', () => {
    const html = renderToStaticMarkup(<TextsView texts={NEWEST} history={false} onHistoryChange={noop} initialOpen="Untyped note" />)

    expect(html).toContain('aria-label="Full text: Untyped note"')
    expect(html).toContain('Line one.\n\n   Line two.')
    expect(html).toContain('>Copy<')
    expect(html).not.toContain('aria-label="Versions"')
  })

  test('with history on, an open row offers each version and the row counts them', () => {
    const html = renderToStaticMarkup(<TextsView texts={HISTORY} history onHistoryChange={noop} initialOpen="Sample cover letter" />)

    expect(html).toContain('aria-label="Versions"')
    expect(html).toContain('<span class="muted"> of 2</span>')
    expect(html.match(/class="button ghost text-version/g)?.length).toBe(2)
    expect(html).toContain('checked=""')
  })

  test('a search with no match says so, and an empty list says how texts arrive', () => {
    const none = renderToStaticMarkup(<TextsView texts={NEWEST} history={false} onHistoryChange={noop} initialQuery="nothing like this" />)
    const empty = renderToStaticMarkup(<TextsView texts={[]} history={false} onHistoryChange={noop} />)

    expect(none).toContain('No text matches this search.')
    expect(empty).toContain('No texts yet.')
    expect(empty).not.toContain('<table')
  })
})
