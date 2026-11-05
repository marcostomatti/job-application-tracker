import type { ReactNode } from 'react'

/**
 * The pre-sign-in shell: a centred card on a softly tinted backdrop, the wordmark above it and
 * an optional line below. A minimised take on the AuthShell template from the component library
 * used elsewhere, in plain CSS with no library behind it.
 */
export interface AuthShellProps {
  /** A short mono kicker as the card's first line. */
  readonly eyebrow?: string
  readonly title: ReactNode
  readonly sub?: ReactNode
  readonly footer?: ReactNode
  readonly children: ReactNode
}

export function AuthShell({ eyebrow, title, sub, footer, children }: AuthShellProps) {
  return (
    <div className="auth-shell">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true" />
        <span className="brand-word">job tracker</span>
      </div>
      <section className="auth-card">
        {eyebrow !== undefined && <div className="eyebrow">{eyebrow}</div>}
        <div>
          <h1 className="auth-title">{title}</h1>
          {sub !== undefined && <p className="auth-sub">{sub}</p>}
        </div>
        {children}
      </section>
      {footer !== undefined && <div className="auth-footer">{footer}</div>}
    </div>
  )
}
