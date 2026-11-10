import { describe, expect, test } from 'bun:test'

import { resolveMcpPort } from '../../src/http/server.ts'

describe('resolveMcpPort', () => {
  test('no option and no MCP_PORT means no listener', () => {
    expect(resolveMcpPort(undefined, {})).toBeUndefined()
    expect(resolveMcpPort(undefined, { MCP_PORT: '' })).toBeUndefined()
  })

  test('MCP_PORT names the port', () => {
    expect(resolveMcpPort(undefined, { MCP_PORT: '8080' })).toBe(8080)
  })

  test("the caller's option wins over MCP_PORT, and 0 asks for a free port", () => {
    expect(resolveMcpPort(9000, { MCP_PORT: '8080' })).toBe(9000)
    expect(resolveMcpPort(0, { MCP_PORT: '8080' })).toBe(0)
  })

  test('a value that is not a port is refused, naming the setting', () => {
    expect(() => resolveMcpPort(undefined, { MCP_PORT: 'http' })).toThrow('MCP_PORT')
    expect(() => resolveMcpPort(undefined, { MCP_PORT: '70000' })).toThrow('MCP_PORT')
    expect(() => resolveMcpPort(1.5, {})).toThrow('mcpPort')
  })
})
