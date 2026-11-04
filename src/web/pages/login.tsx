import { useState, type SyntheticEvent } from 'react'

import { auth, type AuthMode } from '../api.ts'
import { AuthShell } from '../components/auth-shell.tsx'

export interface LoginPageProps {
  readonly mode: AuthMode
  /** Set when the OIDC callback sent the browser back here, from `?error=oidc`. */
  readonly oidcError?: boolean
  readonly onSignedIn: () => void
  /** For tests; the real page calls the server. */
  readonly login?: (password: string) => Promise<unknown>
}

function PasswordForm({ onSignedIn, login }: { onSignedIn: () => void; login: (password: string) => Promise<unknown> }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)

  async function submit(event: SyntheticEvent): Promise<void> {
    event.preventDefault()
    setBusy(true)
    setError(undefined)
    try {
      await login(password)
      onSignedIn()
    } catch (failure: unknown) {
      setError(failure instanceof Error ? failure.message : 'sign-in failed')
      setBusy(false)
    }
  }

  return (
    <form className="stack" onSubmit={submit}>
      <label className="field">
        <span>Password</span>
        <input
          type="password"
          autoComplete="current-password"
          autoFocus
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </label>
      {error !== undefined && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <button className="button primary" type="submit" disabled={busy || password.length === 0}>
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  )
}

/** The sign-in page for whichever mode `AUTH_MODE` set. */
export function LoginPage({ mode, oidcError = false, onSignedIn, login = auth.login }: LoginPageProps) {
  if (mode === 'none') {
    return (
      <AuthShell eyebrow="sign-in is off" title="No login is configured" sub="Set AUTH_MODE in .env to sign in here.">
        <p className="muted">
          With no <code>AUTH_MODE</code>, only the <code>API_KEY</code> opens the API. See “Signing in” in the README.
        </p>
      </AuthShell>
    )
  }
  if (mode === 'oidc') {
    return (
      <AuthShell eyebrow="welcome back" title="Sign in" sub="With the account this tracker is set up for.">
        {oidcError && (
          <p className="error" role="alert">
            That sign-in was refused. Try again, or check the OIDC settings in .env.
          </p>
        )}
        <a className="button primary" href="/auth/oidc/start">
          Continue to your provider
        </a>
      </AuthShell>
    )
  }
  return (
    <AuthShell eyebrow="welcome back" title="Sign in" footer={<span>Lost it? Run <code>bun run reset-credentials</code>.</span>}>
      <PasswordForm onSignedIn={onSignedIn} login={login} />
    </AuthShell>
  )
}
