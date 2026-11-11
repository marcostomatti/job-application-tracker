import { describe, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import type { Db } from '../../src/data/repositories/db.ts'
import { registerTools } from '../../src/mcp/register.ts'
import { ALL_TOOLS } from '../../src/mcp/tools/index.ts'
import { EmptyInputSchema } from '../../src/schemas/common.ts'
import { registryTools } from '../../src/mcp/tools/registries.ts'
import { connectTools, failureText, untouchableDb } from './tools/harness.ts'

/** Listing tools never reaches the database, so a stub that is never called stands in for it. */
const stubDb = {} as Db

interface ListedSchema {
  readonly type?: unknown
  readonly properties?: Record<string, { readonly type?: unknown; readonly anyOf?: unknown }>
  readonly required?: readonly string[]
}

/** Every tool as a client lists it, keyed by name. */
async function listedSchemas(): Promise<Map<string, ListedSchema>> {
  const server = new McpServer({ name: 'test', version: '0.0.0' })
  registerTools(server, stubDb, ALL_TOOLS)
  const client = new Client({ name: 'test-client', version: '0.0.0' })
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverSide), client.connect(clientSide)])
  const { tools } = await client.listTools()
  return new Map(tools.map((tool) => [tool.name, tool.inputSchema as ListedSchema]))
}

/** The JSON Schema types a listed property allows, its own and those of each anyOf branch. */
function typesOf(property: { readonly type?: unknown; readonly anyOf?: unknown } | undefined): unknown[] {
  if (property === undefined) return []
  const branches = Array.isArray(property.anyOf) ? (property.anyOf as Array<{ type?: unknown }>) : []
  return [property.type, ...branches.map((branch) => branch.type)].filter((type) => type !== undefined)
}

describe('published tool input schemas', () => {
  test('every tool that takes input lists its fields, so a client knows what to send', async () => {
    const schemas = await listedSchemas()

    const takesInput = new Set(ALL_TOOLS.filter((tool) => tool.input !== EmptyInputSchema).map((tool) => tool.name))

    const empty = [...schemas]
      .filter(([name, schema]) => takesInput.has(name) && Object.keys(schema.properties ?? {}).length === 0)
      .map(([name]) => name)

    expect(empty).toEqual([])
  })

  test('registry_add lists registry and row, with row as an object', async () => {
    const schema = (await listedSchemas()).get('registry_add')

    expect(schema?.required).toEqual(expect.arrayContaining(['registry', 'row']))
    expect(typesOf(schema?.properties?.row)).toContain('object')
  })

  test('registry_add_bulk lists registry and items, with items as an array', async () => {
    const schema = (await listedSchemas()).get('registry_add_bulk')

    expect(schema?.required).toEqual(expect.arrayContaining(['registry', 'items']))
    expect(typesOf(schema?.properties?.items)).toContain('array')
  })

  test('registry_update lists registry, id and patch, with patch as an object', async () => {
    const schema = (await listedSchemas()).get('registry_update')

    expect(schema?.required).toEqual(expect.arrayContaining(['registry', 'id', 'patch']))
    expect(typesOf(schema?.properties?.patch)).toContain('object')
  })

  test('a field only another registry has passes the listed object but is still refused, in the SDK wording', async () => {
    const client = await connectTools(registryTools, untouchableDb())

    const outcome = await client.call('registry_update', { registry: 'route', id: 1, patch: { sort: 2 } })

    expect(outcome.failed).toBe(true)
    expect(failureText(outcome)).toContain('Input validation error: Invalid arguments for tool registry_update')
    expect(failureText(outcome)).toContain('patch')
  })
})
