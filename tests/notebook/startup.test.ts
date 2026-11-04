import { describe, expect, test } from 'bun:test'

import { NOTEBOOK_TOOL_NAMES } from '../../src/mcp/tools/notebook.ts'
import { notebookStartup, sendsKeyInClear } from '../../src/notebook/startup.ts'
import { startStubNotebook } from './stub-server.ts'

describe('notebookStartup', () => {
  test('no URL: no tools, and one line saying why', async () => {
    const result = await notebookStartup({})
    expect(result.tools).toHaveLength(0)
    expect(result.message).toBe('notebook tools off: OPEN_NOTEBOOK_URL is not set')
  })

  test('a reachable notebook that takes the key: every notebook tool', async () => {
    const stub = startStubNotebook({ password: 'pw' })
    try {
      const result = await notebookStartup({ OPEN_NOTEBOOK_URL: stub.url, OPEN_NOTEBOOK_API_KEY: 'pw' })
      expect(result.tools.map((tool) => tool.name)).toEqual([...NOTEBOOK_TOOL_NAMES])
      expect(result.message).toBe(`notebook tools on: ${NOTEBOOK_TOOL_NAMES.length} Open Notebook tools`)
    } finally {
      await stub.stop()
    }
  })

  test('a wrong key: no tools, and the message names the key variable but not the key or the URL', async () => {
    const stub = startStubNotebook({ password: 'pw' })
    try {
      const result = await notebookStartup({ OPEN_NOTEBOOK_URL: stub.url, OPEN_NOTEBOOK_API_KEY: 'wrong-key' })
      expect(result.tools).toHaveLength(0)
      expect(result.message).toContain('OPEN_NOTEBOOK_API_KEY')
      expect(result.message).not.toContain('wrong-key')
      expect(result.message).not.toContain(stub.url)
    } finally {
      await stub.stop()
    }
  })

  test('an unreachable notebook: no tools', async () => {
    const stub = startStubNotebook()
    const url = stub.url
    await stub.stop()
    const result = await notebookStartup({ OPEN_NOTEBOOK_URL: url }, 500)
    expect(result.tools).toHaveLength(0)
    expect(result.message).toStartWith('notebook tools off: the notebook is unavailable')
  })
})

describe('sendsKeyInClear', () => {
  test('plain http to this machine is fine', () => {
    expect(sendsKeyInClear('http://localhost:5055', 'k')).toBe(false)
    expect(sendsKeyInClear('http://127.0.0.1:5055', 'k')).toBe(false)
    expect(sendsKeyInClear('http://[::1]:5055', 'k')).toBe(false)
  })

  test('plain http to another host with a key is flagged, https and no key are not', () => {
    expect(sendsKeyInClear('http://notebook.example:5055', 'k')).toBe(true)
    expect(sendsKeyInClear('https://notebook.example', 'k')).toBe(false)
    expect(sendsKeyInClear('http://notebook.example:5055', undefined)).toBe(false)
  })
})
