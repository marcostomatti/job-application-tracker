import { createMCP } from '@open-tomato/service-mcp'
import { createLogger } from '@open-tomato/service-logger'

import { getDb } from '../data/client.ts'
import { notebookStartup } from '../notebook/startup.ts'
import { registerTools } from './register.ts'
import { ALL_TOOLS } from './tools/index.ts'
import { applyTransport } from './transport.ts'

/** The name the server logs under and reports to clients. */
const SERVICE_ID = 'job-application-tracker'

// Run it, never import it: createMCP starts on call and exits the process if the start fails.
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

// On stdio, stdout is the protocol channel, so this logger writes to stderr there, as the
// package's own logger does.
const logger = createLogger(SERVICE_ID, { destination: transport === 'stdio' ? 'stderr' : 'stdout' })

const handle = createMCP({
  serviceId: SERVICE_ID,
  // A taken port stops the start instead of moving to the next free one: an MCP client is
  // configured with one URL, and a server on another port would look like a server that is down.
  strictPort: true,
  health: { strictPort: true },
  // In HTTP mode this runs once per connecting client, on that client's own McpServer, so it
  // only registers. The database pool behind getDb() is made once and shared by every session.
  setup: (server) => {
    registerTools(server, getDb(), tools)
  },
})

// Logged once per process, not once per session. A failed start is logged by the package,
// which then exits, so the rejection needs no handling here beyond not being left unhandled.
handle.ready().then(
  () => {
    logger.info({ tools: tools.length }, 'registered MCP tools')
    if (notebook) logger.info({ notebookTools: notebook.tools.length }, notebook.message)
  },
  () => {},
)
