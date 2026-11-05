import { describe, expect, test } from 'bun:test'

import { readNotebookConfig } from '../../src/notebook/config.ts'

describe('readNotebookConfig', () => {
  test('an unset URL turns the notebook tools off and says which variable', () => {
    const result = readNotebookConfig({})
    expect(result).toEqual({ kind: 'off', reason: 'OPEN_NOTEBOOK_URL is not set' })
  })

  test('a blank URL is the same as an unset one', () => {
    expect(readNotebookConfig({ OPEN_NOTEBOOK_URL: '   ' }).kind).toBe('off')
  })

  test('a URL that is not http or https is refused without echoing it', () => {
    const result = readNotebookConfig({ OPEN_NOTEBOOK_URL: 'ftp://notebook.example:21' })
    expect(result.kind).toBe('off')
    if (result.kind === 'off') {
      expect(result.reason).toContain('http')
      expect(result.reason).not.toContain('notebook.example')
    }
  })

  test('a URL that does not parse is refused', () => {
    expect(readNotebookConfig({ OPEN_NOTEBOOK_URL: 'not a url' }).kind).toBe('off')
  })

  test('a URL carrying a user or password is refused, because the key has its own variable', () => {
    const result = readNotebookConfig({ OPEN_NOTEBOOK_URL: 'http://user:secret@localhost:5055' })
    expect(result.kind).toBe('off')
    if (result.kind === 'off') expect(result.reason).not.toContain('secret')
  })

  test('a valid URL loses its trailing slash and keeps the key', () => {
    const result = readNotebookConfig({ OPEN_NOTEBOOK_URL: 'http://localhost:5055/', OPEN_NOTEBOOK_API_KEY: 'k' })
    expect(result).toEqual({ kind: 'on', config: { url: 'http://localhost:5055', apiKey: 'k' } })
  })

  test('a blank key means no key, for a notebook run without a password', () => {
    const result = readNotebookConfig({ OPEN_NOTEBOOK_URL: 'http://localhost:5055', OPEN_NOTEBOOK_API_KEY: '' })
    expect(result).toEqual({ kind: 'on', config: { url: 'http://localhost:5055', apiKey: undefined } })
  })
})
