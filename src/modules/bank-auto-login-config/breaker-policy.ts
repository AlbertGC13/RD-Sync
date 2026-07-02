/**
 * Conservative circuit-breaker policy for per-bank auto-login.
 *
 * CONSERVATIVE BY DESIGN: NO half-open, NO auto-close, NO retry-after-cooldown.
 * Manual admin reset (`BankAutoLoginConfigRepository.resetBreaker`) is the
 * ONLY open->closed transition. Every function is pure — the caller always
 * supplies `now`; nothing here calls `Date.now()`. Unused in production yet
 * (PR4.3 plumbing only) — the state machine wiring lands in PR4.4/4.5.
 */

export type BreakerState = "closed" | "open";

/** The subset of `BankAutoLoginConfigRecord` the policy functions need. */
export interface BreakerRuntimeState {
  breakerState: BreakerState;
  breakerFailureCount: number;
  breakerFailureWindowStart: Date | null;
  breakerOpenedAt: Date | null;
}

export const AutoLoginCircuitBreakerPolicy = {
  /** Exactly one auto-login attempt per expired-session event. */
  maxAttemptsPerEvent: 1,
  /** Rolling window in which failures accumulate toward the open threshold. */
  failureWindowMs: 30 * 60 * 1000,
  /** Breaker opens once this many failures land inside a fresh window. */
  openThreshold: 3,
  /** Explicitly none — no automatic probe while open. */
  halfOpenProbes: 0,
  /** Admin reset is the ONLY transition from open back to closed. */
  manualResetOnly: true,
  /** Alert on open, then at most once per this interval while it stays open. */
  alertRepeatIntervalMs: 30 * 60 * 1000,
} as const;

/** True only while closed. `now` is unused: an open breaker never auto-closes, ever. */
export function canAttempt(state: Pick<BreakerRuntimeState, "breakerState">, now: Date): boolean {
  void now; // manual-reset-only: elapsed time never re-opens the gate
  return state.breakerState === "closed";
}

/** True once the failure count crosses openThreshold within a FRESH window. Already-open never re-evaluates. */
export function shouldOpen(state: BreakerRuntimeState, now: Date): boolean {
  if (state.breakerState === "open") return false;
  if (!isWindowFresh(state.breakerFailureWindowStart, now)) return false;
  return state.breakerFailureCount >= AutoLoginCircuitBreakerPolicy.openThreshold;
}

/** The next persisted breaker fields after recording one new failure at `now`. */
export interface BreakerFailureTransition {
  breakerState: BreakerState;
  breakerFailureCount: number;
  breakerFailureWindowStart: Date | null;
  /** Preserved while already open; set on the failure that crosses the open threshold; otherwise `null`. */
  breakerOpenedAt: Date | null;
}

/**
 * Pure transition: one new failure at `now` -> next state to persist.
 * Already-open is untouched (safe no-op; manual reset is the only exit).
 * Stale/absent window restarts count at 1; fresh window increments.
 * Crossing openThreshold within a fresh window opens the breaker.
 */
export function nextStateOnFailure(state: BreakerRuntimeState, now: Date): BreakerFailureTransition {
  if (state.breakerState === "open") {
    return {
      breakerState: "open",
      breakerFailureCount: state.breakerFailureCount,
      breakerFailureWindowStart: state.breakerFailureWindowStart,
      breakerOpenedAt: state.breakerOpenedAt,
    };
  }

  const windowFresh = isWindowFresh(state.breakerFailureWindowStart, now);
  const breakerFailureCount = windowFresh ? state.breakerFailureCount + 1 : 1;
  const breakerFailureWindowStart = windowFresh ? state.breakerFailureWindowStart! : now;

  if (breakerFailureCount >= AutoLoginCircuitBreakerPolicy.openThreshold) {
    return { breakerState: "open", breakerFailureCount, breakerFailureWindowStart, breakerOpenedAt: now };
  }

  return { breakerState: "closed", breakerFailureCount, breakerFailureWindowStart, breakerOpenedAt: null };
}

function isWindowFresh(windowStart: Date | null, now: Date): boolean {
  if (!windowStart) return false;
  return now.getTime() - windowStart.getTime() < AutoLoginCircuitBreakerPolicy.failureWindowMs;
}
