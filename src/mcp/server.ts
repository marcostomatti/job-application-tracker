import { createMCP } from '@open-tomato/service-mcp'

import { getDb } from '../data/client.ts'
import { notebookStartup } from '../notebook/startup.ts'
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

// The Open Notebook tools exist only when a notebook is configured and answers now, so the
// probe runs before the server starts. Unset, it returns at once and costs nothing.
const notebook = transport === undefined ? undefined : await notebookStartup(process.env)
const tools = [...ALL_TOOLS, ...(notebook?.tools ?? [])]

createMCP({
  serviceId: 'job-application-tracker',
  setup: (server, { logger }) => {
    registerTools(server, getDb(), tools)
    // On stdio, stdout is the protocol channel and the package's logger writes to it, so a log
    // line there would corrupt the stream. stderr is the safe place for the count in that mode.
    if (transport === 'stdio') {
      process.stderr.write(`registered ${tools.length} MCP tools\n`)
      if (notebook) process.stderr.write(`${notebook.message}\n`)
    } else {
      logger.info({ tools: tools.length }, 'registered MCP tools')
      if (notebook) logger.info({ notebookTools: notebook.tools.length }, notebook.message)
    }
  },
})
