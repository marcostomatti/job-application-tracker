import { createMCP } from '@open-tomato/service-mcp'

import { getDb } from '../data/client.ts'
import { registerTools } from './register.ts'
import { ALL_TOOLS } from './tools/index.ts'

// Run it, never import it: createMCP starts on call and exits the process if setup throws.
createMCP({
  serviceId: 'job-application-tracker',
  setup: (server) => registerTools(server, getDb(), ALL_TOOLS),
})
