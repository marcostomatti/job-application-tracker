/** The header every write sends, which the server requires of a cookie-authenticated write (see `src/auth/cookies.ts`). */
const CSRF_HEADERS = { 'x-jat-csrf': '1' } as const

/** A refusal or failure from the server, carrying its envelope's name and message. */
export class ApiError extends Error {
  readonly status: number
  readonly errorName: string

  constructor(
    status: number,
    errorName: string,
    message: string,
  ) {
    super(message)
    this.status = status
    this.errorName = errorName
    this.name = 'ApiError'
  }
}

type Envelope<T> = { success: true; data: T } | { success: false; error: { name: string; message: string } | string }

/** Calls a same-origin JSON route and returns its `data`, or throws an `ApiError` with the envelope's message. */
export async function request<T>(method: string, path: string, body?: unknown, fetchImpl: typeof fetch = fetch): Promise<T> {
  const response = await fetchImpl(path, {
    method,
    credentials: 'same-origin',
    headers: {
      accept: 'application/json',
      ...(method === 'GET' ? {} : CSRF_HEADERS),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  let envelope: Envelope<T> | undefined
  try {
    envelope = (await response.json()) as Envelope<T>
  } catch {
    envelope = undefined
  }
  if (envelope?.success === true) return envelope.data
  const error = envelope?.success === false ? envelope.error : undefined
  if (typeof error === 'object') throw new ApiError(response.status, error.name, error.message)
  throw new ApiError(response.status, 'Error', typeof error === 'string' ? error : `the server answered ${response.status}`)
}

export type AuthMode = 'none' | 'password' | 'oidc'

export interface SessionState {
  readonly mode: AuthMode
  readonly signedIn: boolean
}

export interface TokenSummary {
  readonly id: number
  readonly name: string
  readonly prefix: string
  readonly createdAt: string
  readonly lastUsedAt: string | null
  readonly revokedAt: string | null
}

export const auth = {
  session: (): Promise<SessionState> => request('GET', '/auth/session'),
  login: (password: string): Promise<unknown> => request('POST', '/auth/login', { password }),
  logout: (): Promise<unknown> => request('POST', '/auth/logout'),
  listTokens: (): Promise<TokenSummary[]> => request('GET', '/auth/tokens'),
  createToken: (name: string): Promise<{ token: string; summary: TokenSummary }> => request('POST', '/auth/tokens', { name }),
  revokeToken: (id: number): Promise<TokenSummary> => request('DELETE', `/auth/tokens/${id}`),
}
