import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import { PAGES } from '../../src/web/app.tsx'
import type { AppSettings } from '../../src/web/data.ts'
import { ratioToStars, SettingsPage, settingsPatch, starsToRatio } from '../../src/web/pages/settings.tsx'

const SAVED: AppSettings = { askFloor: 0.5, recommendationDisplay: 'both' }

describe('SettingsPage', () => {
  test('offers the three displays with one line each, the saved one checked', () => {
    const html = renderToStaticMarkup(<SettingsPage initial={SAVED} />)

    expect(html.match(/type="radio"/g)?.length).toBe(3)
    for (const line of ['Computed from the score, the gates and the ask floor.', 'where the agent gave none', 'Side by side, with disagreements flagged.']) {
      expect(html).toContain(line)
    }
    expect(html).toMatch(/checked="" value="both"/)
    expect(html.match(/checked=""/g)?.length).toBe(1)
  })

  test('shows the ask floor in stars with its percent, and Save waits for a change', () => {
    const html = renderToStaticMarkup(<SettingsPage initial={{ ...SAVED, askFloor: 0.6 }} />)

    expect(html).toContain('Ask floor (stars)')
    expect(html).toContain('value="3"')
    expect(html).toContain('3 stars (60%)')
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled=""/)
  })

  test('loads until the settings are read', () => {
    const api = { settings: () => new Promise<AppSettings>(() => undefined), updateSettings: async () => SAVED }

    expect(renderToStaticMarkup(<SettingsPage api={api} />)).toContain('Loading…')
  })

  test('is in the nav', () => {
    expect(PAGES.map((page) => page.path)).toContain('/settings')
  })
})

describe('the ask floor in stars', () => {
  test('a ratio shows as stars to one decimal, and a typed star value stores as its ratio', () => {
    expect(ratioToStars(0.5)).toBe(2.5)
    expect(ratioToStars(0.62)).toBe(3.1)
    expect(starsToRatio('2.5')).toBe(0.5)
    expect(starsToRatio('3.1')).toBe(0.62)
    expect(starsToRatio('0')).toBe(0)
    expect(starsToRatio('5')).toBe(1)
  })

  test('anything that is not a number from 0 to 5 is refused', () => {
    for (const raw of ['', ' ', 'abc', '-0.1', '5.1', 'Infinity']) expect(starsToRatio(raw)).toBeNull()
  })
})

describe('settingsPatch', () => {
  test('names only the fields that changed, and is null when none did', () => {
    expect(settingsPatch(SAVED, 'both', 0.5)).toBeNull()
    expect(settingsPatch(SAVED, 'agent', 0.5)).toEqual({ recommendationDisplay: 'agent' })
    expect(settingsPatch(SAVED, 'both', 0.6)).toEqual({ askFloor: 0.6 })
    expect(settingsPatch(SAVED, 'rules', 0.4)).toEqual({ recommendationDisplay: 'rules', askFloor: 0.4 })
  })
})
