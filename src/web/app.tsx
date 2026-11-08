import { useCallback, useEffect, useState, type ReactNode } from 'react'

import { auth, type SessionState } from './api.ts'
import { BoardPage } from './pages/board/index.tsx'
import { CriteriaPage } from './pages/criteria.tsx'
import { LoginPage } from './pages/login.tsx'
import { PostingsPage } from './pages/postings/index.tsx'
import { SettingsPage } from './pages/settings.tsx'
import { StatsPage } from './pages/stats.tsx'
import { TextsPage } from './pages/texts.tsx'
import { TokensPage } from './pages/tokens.tsx'

/** One page the signed-in app shows, and its place in the nav. */
export interface AppPage {
  readonly path: string
  readonly label: string
  readonly render: () => ReactNode
}

/** The pages behind the sign-in, in nav order. The first is where `/` lands. */
export const PAGES: readonly AppPage[] = [
  { path: '/board', label: 'Board', render: () => <BoardPage /> },
  { path: '/postings', label: 'Postings', render: () => <PostingsPage /> },
  { path: '/texts', label: 'Texts', render: () => <TextsPage /> },
  { path: '/criteria', label: 'Criteria', render: () => <CriteriaPage /> },
  { path: '/stats', label: 'Stats', render: () => <StatsPage /> },
  { path: '/tokens', label: 'Tokens', render: () => <TokensPage /> },
  { path: '/settings', label: 'Settings', render: () => <SettingsPage /> },
]

/** The page for a path, or the first page for `/` and for any path the app does not draw. */
export function pageFor(path: string): AppPage {
  const first = PAGES[0]
  if (!first) throw new Error('the app has no pages')
  return PAGES.find((page) => page.path === path) ?? first
}

function navigate(path: string): void {
  window.history.pushState(null, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

function usePath(): string {
  const [path, setPath] = useState(() => window.location.pathname)
  useEffect(() => {
    const onPop = (): void => setPath(window.location.pathname)
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  return path
}

export interface AppShellProps {
  readonly current: AppPage
  readonly onSignOut: () => void
  readonly children: ReactNode
}

/** The signed-in frame: the wordmark, the nav and sign-out across the top, the page below. */
export function AppShell({ current, onSignOut, children }: AppShellProps) {
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand small">
          <span className="brand-mark" aria-hidden="true" />
          <span className="brand-word">job tracker</span>
        </div>
        <nav className="nav" aria-label="Main">
          {PAGES.map((page) => (
            <a
              key={page.path}
              href={page.path}
              aria-current={page === current ? 'page' : undefined}
              onClick={(event) => {
                event.preventDefault()
                navigate(page.path)
              }}
            >
              {page.label}
            </a>
          ))}
        </nav>
        <button className="button ghost" type="button" onClick={onSignOut}>
          Sign out
        </button>
      </header>
      <main>{children}</main>
    </div>
  )
}

/** Asks the server whether this browser is signed in, then shows the login page or the app. */
export function App() {
  const path = usePath()
  const [session, setSession] = useState<SessionState | undefined>()
  const [error, setError] = useState<string | undefined>()

  const refresh = useCallback(async () => {
    try {
      setSession(await auth.session())
    } catch (failure: unknown) {
      setError(failure instanceof Error ? failure.message : 'the server did not answer')
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  if (error !== undefined) return <p className="error page">{error}</p>
  if (session === undefined) return <p className="muted page">Loading…</p>

  if (!session.signedIn) {
    const oidcError = new URLSearchParams(window.location.search).get('error') === 'oidc'
    return (
      <LoginPage
        mode={session.mode}
        oidcError={oidcError}
        onSignedIn={() => {
          navigate(pageFor('/').path)
          void refresh()
        }}
      />
    )
  }

  const current = pageFor(path)
  if (path !== current.path) window.history.replaceState(null, '', current.path)
  return (
    <AppShell
      current={current}
      onSignOut={() => {
        void auth.logout().then(() => {
          navigate('/login')
          return refresh()
        })
      }}
    >
      {current.render()}
    </AppShell>
  )
}
