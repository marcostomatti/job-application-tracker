/** Where the Open Notebook API is, and the password it wants as a bearer token, if any. */
export interface NotebookConfig {
  readonly url: string
  readonly apiKey: string | undefined
}

/** Either a configuration to probe, or the one-line reason the notebook tools stay off. */
export type NotebookConfigResult =
  | { readonly kind: 'on'; readonly config: NotebookConfig }
  | { readonly kind: 'off'; readonly reason: string }

const URL_VARIABLE = 'OPEN_NOTEBOOK_URL'
const KEY_VARIABLE = 'OPEN_NOTEBOOK_API_KEY'

/**
 * Reads the notebook's address and key from the environment. Nothing set means off, which is
 * the normal case for a tracker run without a notebook. A reason never repeats the value it
 * refused, because the value can name a host or carry a password and the reason is logged.
 */
export function readNotebookConfig(env: Record<string, string | undefined>): NotebookConfigResult {
  const raw = env[URL_VARIABLE]?.trim()
  if (raw === undefined || raw === '') return { kind: 'off', reason: `${URL_VARIABLE} is not set` }

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return { kind: 'off', reason: `${URL_VARIABLE} is not a URL` }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { kind: 'off', reason: `${URL_VARIABLE} must start with http:// or https://` }
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return { kind: 'off', reason: `${URL_VARIABLE} must not carry a user or password; put the password in ${KEY_VARIABLE}` }
  }

  const key = env[KEY_VARIABLE]?.trim()
  const url = `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '')
  return { kind: 'on', config: { url, apiKey: key === undefined || key === '' ? undefined : key } }
}
