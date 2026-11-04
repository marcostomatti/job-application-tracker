import { describe, expect, test } from 'bun:test'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import type { Db } from '../../src/data/repositories/db.ts'
import { registerTools } from '../../src/mcp/register.ts'
import { ALL_TOOLS } from '../../src/mcp/tools/index.ts'

/**
 * Imports `tools/index.ts` and never `server.ts`: `createMCP` starts the server when called
 * and exits the process if setup throws, so nothing a test imports may reach it.
 */

/** Only the definitions are inspected; `Db` is handed through to `run` and never called here. */
const stubDb = {} as Db

describe('ALL_TOOLS', () => {
  test('ALL_TOOLS has no duplicate name', () => {
    const names = ALL_TOOLS.map((tool) => tool.name)
    expect(names.length).toBe(new Set(names).size)
  })

  test('ALL_TOOLS covers groups 1 to 9 of the spec', () => {
    expect(ALL_TOOLS.length).toBe(55)
  })

  test('every tool has a non-empty title and description', () => {
    for (const tool of ALL_TOOLS) {
      expect(tool.title.trim().length).toBeGreaterThan(0)
      expect(tool.description.trim().length).toBeGreaterThan(0)
    }
  })

  test('each collection write has a bulk sibling', () => {
    const names = new Set(ALL_TOOLS.map((tool) => tool.name))
    for (const single of [
      'posting_add',
      'posting_update',
      'summary_write',
      'score_posting',
      'registry_add',
      'text_add',
      'stage_append',
      'origin_record',
    ]) {
      expect(names.has(`${single}_bulk`)).toBe(true)
    }
  })

  test('registering every tool against one server raises nothing', () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' })
    expect(() => registerTools(server, stubDb, ALL_TOOLS)).not.toThrow()
  })
})
