/** Login attempts without a success before the login pauses. */
const MAX_FAILURES = 5

/** How long the pause lasts. */
const LOCKOUT_MS = 60_000

/**
 * A pause after repeated wrong passwords, kept in memory for the one user. It slows a guesser
 * to five tries a minute; a restart resets it, which is fine for a lock on a drawer that is
 * already inside the desk.
 *
 * An attempt is counted when it starts, before the password is checked, and refunded only by a
 * success. Counting after the check would let a burst of parallel requests all pass the check
 * before the first failure was recorded.
 */
export class LoginThrottle {
  private attempts = 0
  private lockedUntil = 0

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Seconds left in the pause, or 0 when this attempt may go ahead, in which case it is counted.
   * The attempt that reaches the limit still goes ahead; the ones after it wait.
   */
  begin(): number {
    const left = this.lockedUntil - this.now()
    if (left > 0) return Math.ceil(left / 1000)
    this.attempts += 1
    if (this.attempts >= MAX_FAILURES) {
      this.lockedUntil = this.now() + LOCKOUT_MS
      this.attempts = 0
    }
    return 0
  }

  succeeded(): void {
    this.attempts = 0
    this.lockedUntil = 0
  }
}
