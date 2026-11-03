import { createMCP } from '@open-tomato/service-mcp'

import { getDb } from '../data/client.ts'
import { registerTools } from './register.ts'
import { ALL_TOOLS } from './tools/index.ts'

// Run it, never import it: createMCP starts on call and exits the process if setup throws.
// The package reads the transport from MCP_TRANSPORT and picks HTTP unless it is 'stdio', so
// the safe default (no unauthenticated port) is set here. `MCP_TRANSPORT=http` opts in to HTTP.
process.env.MCP_TRANSPORT ??= 'stdio'

createMCP({
  serviceId: 'job-application-tracker',
  setup: (server, { logger }) => {
    registerTools(server, getDb(), ALL_TOOLS)
    // On stdio, stdout is the protocol channel and the package's logger writes to it, so a log
    // line there would corrupt the stream. stderr is the safe place for the count in that mode.
    if (process.env.MCP_TRANSPORT === 'stdio') {
      process.stderr.write(`registered ${ALL_TOOLS.length} MCP tools\n`)
    } else {
      logger.info({ tools: ALL_TOOLS.length }, 'registered MCP tools')
    }
  },
})
