import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getParseErrorMessage } from '@modelcontextprotocol/sdk/server/zod-compat.js'
import { type CallToolResult, ErrorCode, McpError, type ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import type { z, ZodType } from 'zod'

import type { Db } from '../data/repositories/db.ts'
import { publishedInput } from './published-input.ts'
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
  /**
   * The SDK's read-only and destructive hints, which a client may use to decide whether a call
   * needs explicit approval. Optional, and sent to `registerTool` only when present. Which tools
   * carry which hint is each tool author's call.
   */
  readonly annotations?: ToolAnnotations
  readonly run: (args: unknown, db: Db) => Promise<unknown>
}

/** What a tool module passes to `defineTool`: `run` sees the parsed output type of `input`. */
export interface ToolSpec<S extends ZodType> {
  readonly name: string
  readonly title: string
  readonly description: string
  readonly input: S
  readonly annotations?: ToolAnnotations
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
    ...(spec.annotations === undefined ? {} : { annotations: spec.annotations }),
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
 *
 * A tool whose input is a union is listed with `publishedInput`'s object, so a client sees its
 * fields. The SDK checks a call against that looser object, and the handler then checks it
 * against the tool's own union, refusing it with the SDK's own wording. The second parse reads
 * the first one's output, so it is sound only for a union whose branches add no defaults and
 * whose transforms give the same value when run twice (a `trim`, as the registry schemas have).
 */
export function registerTools(server: McpServer, db: Db, definitions: readonly ToolDefinition[]): void {
  for (const definition of definitions) {
    const published = publishedInput(definition.input)
    server.registerTool(
      definition.name,
      {
        title: definition.title,
        description: definition.description,
        inputSchema: published,
        ...(definition.annotations === undefined ? {} : { annotations: definition.annotations }),
      },
      async (args: unknown): Promise<CallToolResult> => {
        const parsed = published === definition.input ? args : parseOwnInput(definition, args)
        try {
          return okResult(await definition.run(parsed, db))
        } catch (error: unknown) {
          return errorResult(error)
        }
      },
    )
  }
}

/**
 * Parses a call with the tool's own schema, after the SDK parsed it with the published one.
 * A refusal is thrown as the SDK's own `InvalidParams` error, worded as the SDK words it, so a
 * client cannot tell which of the two parses refused the call.
 */
function parseOwnInput(definition: ToolDefinition, args: unknown): unknown {
  const result = definition.input.safeParse(args)
  if (result.success) return result.data
  throw new McpError(
    ErrorCode.InvalidParams,
    `Input validation error: Invalid arguments for tool ${definition.name}: ${getParseErrorMessage(result.error)}`,
  )
}
