import { useCallback, useEffect, useState, type SyntheticEvent } from 'react'

import { auth, type TokenSummary } from '../api.ts'

/** What the page needs from the server; the real one by default, a stand-in in tests. */
export interface TokenApi {
  listTokens(): Promise<TokenSummary[]>
  createToken(name: string): Promise<{ token: string; summary: TokenSummary }>
  revokeToken(id: number): Promise<TokenSummary>
}

export interface TokensPageProps {
  readonly api?: TokenApi
  /** The first list, for a render with no server. */
  readonly initial?: readonly TokenSummary[]
}

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

function when(iso: string | null): string {
  return iso === null ? '—' : dateFormat.format(new Date(iso))
}

/** The token just minted, shown once with a copy button; it is gone when the banner is dismissed. */
function NewToken({ token, onDone }: { token: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="callout" role="status">
      <strong>Copy this token now.</strong> It is shown once and is not stored; only its hash is.
      <div className="token-row">
        <code className="token">{token}</code>
        <button
          className="button"
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(token).then(() => setCopied(true))
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button className="button ghost" type="button" onClick={onDone}>
          Done
        </button>
      </div>
      <p className="muted">
        Send it as <code>Authorization: Bearer &lt;token&gt;</code> to <code>/api</code>.
      </p>
    </div>
  )
}

export function TokensPage({ api = auth, initial = [] }: TokensPageProps) {
  const [tokens, setTokens] = useState<readonly TokenSummary[]>(initial)
  const [name, setName] = useState('')
  const [fresh, setFresh] = useState<string | undefined>()
  const [error, setError] = useState<string | undefined>()

  const reload = useCallback(async () => {
    try {
      setTokens(await api.listTokens())
    } catch (failure: unknown) {
      setError(failure instanceof Error ? failure.message : 'could not load the tokens')
    }
  }, [api])

  useEffect(() => {
    void reload()
  }, [reload])

  async function mint(event: SyntheticEvent): Promise<void> {
    event.preventDefault()
    setError(undefined)
    try {
      const { token } = await api.createToken(name)
      setFresh(token)
      setName('')
      await reload()
    } catch (failure: unknown) {
      setError(failure instanceof Error ? failure.message : 'could not create the token')
    }
  }

  async function revoke(token: TokenSummary): Promise<void> {
    if (!window.confirm(`Revoke “${token.name}”? Anything using it is refused from now on.`)) return
    try {
      await api.revokeToken(token.id)
      await reload()
    } catch (failure: unknown) {
      setError(failure instanceof Error ? failure.message : 'could not revoke the token')
    }
  }

  return (
    <div className="page">
      <header className="page-head">
        <h1>API tokens</h1>
        <p className="muted">One per agent or HTTP client, so each can be revoked on its own. The MCP server over stdio needs none.</p>
      </header>

      <form className="card inline-form" onSubmit={mint}>
        <label className="field grow">
          <span>Name</span>
          <input placeholder="e.g. research agent" maxLength={80} value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <button className="button primary" type="submit" disabled={name.trim().length === 0}>
          Create token
        </button>
      </form>

      {fresh !== undefined && <NewToken token={fresh} onDone={() => setFresh(undefined)} />}
      {error !== undefined && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <div className="card">
        {tokens.length === 0 ? (
          <p className="muted">No tokens yet.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Starts with</th>
                <th>Created</th>
                <th>Last used</th>
                <th>Status</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {tokens.map((token) => (
                <tr key={token.id} className={token.revokedAt === null ? '' : 'revoked'}>
                  <td>{token.name}</td>
                  <td>
                    <code>{token.prefix}…</code>
                  </td>
                  <td>{when(token.createdAt)}</td>
                  <td>{when(token.lastUsedAt)}</td>
                  <td>{token.revokedAt === null ? 'active' : `revoked ${when(token.revokedAt)}`}</td>
                  <td>
                    {token.revokedAt === null && (
                      <button className="button ghost danger" type="button" onClick={() => void revoke(token)}>
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
