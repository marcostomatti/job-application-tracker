import type { ToolDefinition } from '../register.ts'
import { criteriaTools } from './criteria.ts'
import { dispositionTools } from './dispositions.ts'
import { positionTools } from './positions.ts'
import { provenanceTools } from './provenance.ts'
import { registryTools } from './registries.ts'
import { scoreTools } from './scores.ts'
import { summaryTools } from './summaries.ts'
import { textTools } from './texts.ts'

/**
 * Every MCP tool the service offers, in the spec's group order (§11.1 groups 1 to 9).
 *
 * This file only assembles the arrays and starts nothing, so a test can import it. The entry
 * point that starts the server is `server.ts`, which no test imports.
 */
export const ALL_TOOLS: readonly ToolDefinition[] = [
  ...positionTools,
  ...summaryTools,
  ...scoreTools,
  ...criteriaTools,
  ...registryTools,
  ...textTools,
  ...dispositionTools,
  ...provenanceTools,
]
