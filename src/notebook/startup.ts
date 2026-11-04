import type { ToolDefinition } from '../mcp/register.ts'
import { notebookToolsFor } from '../mcp/tools/notebook.ts'
import { NotebookClient } from './client.ts'
import { readNotebookConfig } from './config.ts'
import { probeNotebook, PROBE_TIMEOUT_MS } from './probe.ts'

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/** True when a key would cross a network in clear text: plain http to a host that is not this machine. */
export function sendsKeyInClear(url: string, apiKey: string | undefined): boolean {
  if (apiKey === undefined) return false
  const { protocol, hostname } = new URL(url)
  const local = LOOPBACK_HOSTS.has(hostname) || hostname.endsWith('.localhost') || hostname.startsWith('127.')
  return protocol === 'http:' && !local
}

/** The notebook tools to register, and the one line the server logs about them. */
export interface NotebookStartup {
  readonly tools: readonly ToolDefinition[]
  readonly message: string
}

/**
 * Decides at startup whether the notebook tools exist. They do only when `OPEN_NOTEBOOK_URL`
 * is set and the notebook answers an authenticated read; otherwise none is registered and the
 * message says why. The message never holds the URL or the key, because it is logged.
 *
 * A notebook that answers now and drops later keeps its tools; each call then fails with
 * `NotebookUnavailableError`, and a notebook that comes back is used again on the next call.
 */
export async function notebookStartup(
  env: Record<string, string | undefined>,
  probeTimeoutMs = PROBE_TIMEOUT_MS,
): Promise<NotebookStartup> {
  const config = readNotebookConfig(env)
  if (config.kind === 'off') return { tools: [], message: `notebook tools off: ${config.reason}` }
  const client = new NotebookClient(config.config)
  const probe = await probeNotebook(client, probeTimeoutMs)
  if (!probe.ok) return { tools: [], message: `notebook tools off: ${probe.reason}` }
  const tools = notebookToolsFor(client)
  const warning = sendsKeyInClear(config.config.url, config.config.apiKey)
    ? '; warning: the key is sent over plain http to a host that is not this machine'
    : ''
  return { tools, message: `notebook tools on: ${tools.length} Open Notebook tools${warning}` }
}
