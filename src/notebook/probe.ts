import type { NotebookClient } from './client.ts'

/** How long startup waits for the notebook before it leaves the notebook tools off. */
export const PROBE_TIMEOUT_MS = 3_000

export type ProbeResult = { readonly ok: true } | { readonly ok: false; readonly reason: string }

/**
 * Asks the notebook for one authenticated read, so a wrong key is found at startup as well as
 * an unreachable host. The reason is the error's own message, which never holds the URL.
 */
export async function probeNotebook(client: NotebookClient, timeoutMs = PROBE_TIMEOUT_MS): Promise<ProbeResult> {
  try {
    await client.ping(timeoutMs)
    return { ok: true }
  } catch (error: unknown) {
    return { ok: false, reason: error instanceof Error ? error.message : 'the probe failed' }
  }
}
