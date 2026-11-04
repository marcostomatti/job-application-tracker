import { createMCP } from '@open-tomato/service-mcp'

import { getDb } from '../data/client.ts'
import { registerTools } from './register.ts'
import { ALL_TOOLS } from './tools/index.ts'
import { applyTransport } from './transport.ts'

// Run it, never import it: createMCP starts on call and exits the process if setup throws.
// The package treats every MCP_TRANSPORT value except exactly 'stdio' as HTTP, so the value is
// checked and normalised here first: unset or blank is stdio, 'http' opts in, anything else exits.
const transport = applyTransport(process.env, {
  write: (text) => void process.stderr.write(text),
  exit: (code) => process.exit(code),
})

createMCP({
  serviceId: 'job-application-tracker',
  setup: (server, { logger }) => {
    registerTools(server, getDb(), ALL_TOOLS)
    // On stdio, stdout is the protocol channel and the package's logger writes to it, so a log
    // line there would corrupt the stream. stderr is the safe place for the count in that mode.
    if (transport === 'stdio') {
      process.stderr.write(`registered ${ALL_TOOLS.length} MCP tools\n`)
    } else {
      logger.info({ tools: ALL_TOOLS.length }, 'registered MCP tools')
    }
  },
})
