import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { z, ZodType } from 'zod'

import type { Db } from '../data/repositories/db.ts'
import { errorResult, okResult } from './result.ts'

/**
 * The one shape every tool module exports: a name, the words a client shows, the Zod schema
 * of its input, and the function that does the work.
 *
 * `input` is a plain Zod schema with nothing MCP-specific in it, so the HTTP route that mirrors
 * the tool can parse with the same object. `run` takes `unknown` here because a list of
 * definitions mixes schemas; `defineTool` is the one place that ties its argument type to `input`.
 */
export interface ToolDefinition {
  readonly name: string
  readonly title: string
  readonly description: string
  readonly input: ZodType
  readonly run: (args: unknown, db: Db) => Promise<unknown>
}

/** What a tool module passes to `defineTool`: `run` sees the parsed output type of `input`. */
export interface ToolSpec<S extends ZodType> {
  readonly name: string
  readonly title: string
  readonly description: string
  readonly input: S
  readonly run: (args: z.infer<S>, db: Db) => Promise<unknown>
}

/**
 * Builds a `ToolDefinition`, typing `run`'s arguments from the schema. The cast to `unknown`
 * is sound because `registerTools` hands `run` only what `input` parsed: the SDK validates a
 * call against the schema before it reaches the handler.
 */
export function defineTool<S extends ZodType>(spec: ToolSpec<S>): ToolDefinition {
  return {
    name: spec.name,
    title: spec.title,
    description: spec.description,
    input: spec.input,
    run: (args, db) => spec.run(args as z.infer<S>, db),
  }
}

/**
 * Registers every definition on the server, wrapping each `run` so that a thrown error, or a
 * result JSON cannot hold, comes back as an `errorResult` instead of rejecting.
 *
 * This is a plain function over a server it is given, not one that creates a server: the
 * entry point that calls `createMCP` (which starts at once and exits the process when setup
 * throws) is the only place that may, and a test can pass a bare `McpServer`. The SDK throws
 * when two definitions share a name.
 */
export function registerTools(server: McpServer, db: Db, definitions: readonly ToolDefinition[]): void {
  for (const definition of definitions) {
    server.registerTool(
      definition.name,
      { title: definition.title, description: definition.description, inputSchema: definition.input },
      async (args: unknown): Promise<CallToolResult> => {
        try {
          return okResult(await definition.run(args, db))
        } catch (error: unknown) {
          return errorResult(error)
        }
      },
    )
  }
}
