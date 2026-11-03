import { describe, expect, test } from 'bun:test'

import { applyTransport, resolveTransport } from '../../src/mcp/transport.ts'

/** Imports `transport.ts` only: `server.ts` starts a server and is never imported by a test. */

describe('resolveTransport', () => {
  test('an unset value means stdio', () => {
    expect(resolveTransport({})).toBe('stdio')
    expect(resolveTransport({ MCP_TRANSPORT: undefined })).toBe('stdio')
  })

  test('a blank value means stdio, not HTTP', () => {
    expect(resolveTransport({ MCP_TRANSPORT: '' })).toBe('stdio')
    expect(resolveTransport({ MCP_TRANSPORT: '   ' })).toBe('stdio')
  })

  test('the exact value stdio means stdio', () => {
    expect(resolveTransport({ MCP_TRANSPORT: 'stdio' })).toBe('stdio')
  })

  test('the exact value http means http', () => {
    expect(resolveTransport({ MCP_TRANSPORT: 'http' })).toBe('http')
  })

  test('a wrong case is rejected and the message names the value it got', () => {
    expect(() => resolveTransport({ MCP_TRANSPORT: 'HTTP' })).toThrow('"HTTP"')
    expect(() => resolveTransport({ MCP_TRANSPORT: 'Stdio' })).toThrow('"Stdio"')
  })

  test('an unknown value or a typo is rejected', () => {
    expect(() => resolveTransport({ MCP_TRANSPORT: 'std' })).toThrow('"std"')
    expect(() => resolveTransport({ MCP_TRANSPORT: 'sse' })).toThrow('"sse"')
    expect(() => resolveTransport({ MCP_TRANSPORT: ' http ' })).toThrow('" http "')
  })
})

describe('applyTransport', () => {
  function harness(): {
    written: string[]
    exits: number[]
    io: { write: (text: string) => void; exit: (code: number) => unknown }
  } {
    const written: string[] = []
    const exits: number[] = []
    return { written, exits, io: { write: (text) => void written.push(text), exit: (code) => void exits.push(code) } }
  }

  test('unset leaves the env at stdio, so the package never sees a value it reads as HTTP', () => {
    const { io, exits } = harness()
    const env: Record<string, string | undefined> = {}
    expect(applyTransport(env, io)).toBe('stdio')
    expect(env.MCP_TRANSPORT).toBe('stdio')
    expect(exits).toEqual([])
  })

  test('a blank value is rewritten to stdio in the env', () => {
    const { io, exits } = harness()
    const env: Record<string, string | undefined> = { MCP_TRANSPORT: '' }
    expect(applyTransport(env, io)).toBe('stdio')
    expect(env.MCP_TRANSPORT).toBe('stdio')
    expect(exits).toEqual([])
  })

  test('http stays http in the env', () => {
    const { io, exits } = harness()
    const env: Record<string, string | undefined> = { MCP_TRANSPORT: 'http' }
    expect(applyTransport(env, io)).toBe('http')
    expect(env.MCP_TRANSPORT).toBe('http')
    expect(exits).toEqual([])
  })

  test('an unknown value writes a message naming it, exits 1, and leaves the env alone', () => {
    const { io, written, exits } = harness()
    const env: Record<string, string | undefined> = { MCP_TRANSPORT: 'Http' }
    expect(applyTransport(env, io)).toBeUndefined()
    expect(exits).toEqual([1])
    expect(written.join('')).toContain('"Http"')
    expect(written.join('')).toContain('stdio')
    expect(env.MCP_TRANSPORT).toBe('Http')
  })
})
