import { describe, expect, it } from "vitest";
import {
  AutoLoginCircuitBreakerPolicy,
  canAttempt,
  nextStateOnFailure,
  shouldOpen,
  type BreakerRuntimeState,
} from "./breaker-policy";

const T0 = new Date("2026-07-02T12:00:00.000Z");
const closed = (overrides: Partial<BreakerRuntimeState> = {}): BreakerRuntimeState => ({
  breakerState: "closed",
  breakerFailureCount: 0,
  breakerFailureWindowStart: null,
  breakerOpenedAt: null,
  ...overrides,
});
const minutes = (n: number) => n * 60 * 1000;

describe("AutoLoginCircuitBreakerPolicy constants", () => {
  it("matches the design.md conservative policy verbatim", () => {
    expect(AutoLoginCircuitBreakerPolicy).toEqual({
      maxAttemptsPerEvent: 1,
      failureWindowMs: minutes(30),
      openThreshold: 3,
      halfOpenProbes: 0,
      manualResetOnly: true,
      alertRepeatIntervalMs: minutes(30),
    });
  });
});

describe("canAttempt", () => {
  it("is true while closed", () => {
    expect(canAttempt({ breakerState: "closed" }, T0)).toBe(true);
  });

  it("is false while open, regardless of elapsed time (no auto-close)", () => {
    expect(canAttempt({ breakerState: "open" }, T0)).toBe(false);
    const farFuture = new Date(T0.getTime() + minutes(24 * 60));
    expect(canAttempt({ breakerState: "open" }, farFuture)).toBe(false);
  });
});

describe("nextStateOnFailure — accrual within the window", () => {
  it("first failure: count=1, window starts now, stays closed", () => {
    const next = nextStateOnFailure(closed(), T0);
    expect(next).toEqual({
      breakerState: "closed",
      breakerFailureCount: 1,
      breakerFailureWindowStart: T0,
      breakerOpenedAt: null,
    });
  });

  it("second failure inside window: count=2, window unchanged, stays closed", () => {
    const afterFirst = nextStateOnFailure(closed(), T0);
    const t1 = new Date(T0.getTime() + minutes(5));
    const next = nextStateOnFailure(afterFirst, t1);
    expect(next).toEqual({
      breakerState: "closed",
      breakerFailureCount: 2,
      breakerFailureWindowStart: T0,
      breakerOpenedAt: null,
    });
  });

  it("third failure inside window opens the breaker and stamps breakerOpenedAt", () => {
    let state = nextStateOnFailure(closed(), T0);
    state = nextStateOnFailure(state, new Date(T0.getTime() + minutes(5)));
    const t2 = new Date(T0.getTime() + minutes(10));
    const next = nextStateOnFailure(state, t2);
    expect(next).toEqual({
      breakerState: "open",
      breakerFailureCount: 3,
      breakerFailureWindowStart: T0,
      breakerOpenedAt: t2,
    });
  });
});

describe("nextStateOnFailure — stale window restart", () => {
  it("restarts count at 1 with a fresh window when the prior window has elapsed", () => {
    const staleState: BreakerRuntimeState = {
      breakerState: "closed",
      breakerFailureCount: 2,
      breakerFailureWindowStart: T0,
      breakerOpenedAt: null,
    };
    const t = new Date(T0.getTime() + minutes(31)); // just past failureWindowMs
    const next = nextStateOnFailure(staleState, t);
    expect(next).toEqual({
      breakerState: "closed",
      breakerFailureCount: 1,
      breakerFailureWindowStart: t,
      breakerOpenedAt: null,
    });
  });

  it("treats the exact failure-window boundary as stale", () => {
    const boundaryState: BreakerRuntimeState = {
      breakerState: "closed",
      breakerFailureCount: 2,
      breakerFailureWindowStart: T0,
      breakerOpenedAt: null,
    };
    const exactBoundary = new Date(T0.getTime() + AutoLoginCircuitBreakerPolicy.failureWindowMs);
    const next = nextStateOnFailure(boundaryState, exactBoundary);
    expect(next).toEqual({
      breakerState: "closed",
      breakerFailureCount: 1,
      breakerFailureWindowStart: exactBoundary,
      breakerOpenedAt: null,
    });
  });

  it("two failures separated by a stale gap never reach the open threshold", () => {
    let state = nextStateOnFailure(closed(), T0);
    const muchLater = new Date(T0.getTime() + minutes(90));
    state = nextStateOnFailure(state, muchLater);
    expect(state.breakerState).toBe("closed");
    expect(state.breakerFailureCount).toBe(1); // restarted, not accumulated to 2
  });
});

describe("nextStateOnFailure — open stays open (no half-open, no auto-close)", () => {
  it("recording a failure while already open is a safe no-op", () => {
    const openedAt = new Date(T0.getTime() + minutes(10));
    const openState: BreakerRuntimeState = {
      breakerState: "open",
      breakerFailureCount: 3,
      breakerFailureWindowStart: T0,
      breakerOpenedAt: openedAt,
    };
    const later = new Date(T0.getTime() + minutes(45));
    const next = nextStateOnFailure(openState, later);
    expect(next).toEqual({
      breakerState: "open",
      breakerFailureCount: 3,
      breakerFailureWindowStart: T0,
      breakerOpenedAt: openedAt,
    });
  });

  it("preserves a null failure window while already open", () => {
    const openState: BreakerRuntimeState = {
      breakerState: "open",
      breakerFailureCount: 3,
      breakerFailureWindowStart: null,
      breakerOpenedAt: null,
    };
    const later = new Date(T0.getTime() + minutes(45));
    const next = nextStateOnFailure(openState, later);
    expect(next).toEqual({
      breakerState: "open",
      breakerFailureCount: 3,
      breakerFailureWindowStart: null,
      breakerOpenedAt: null,
    });
  });

  it("stays open forever without a manual reset, no matter how much time passes", () => {
    const openState: BreakerRuntimeState = {
      breakerState: "open",
      breakerFailureCount: 3,
      breakerFailureWindowStart: T0,
      breakerOpenedAt: T0,
    };
    const oneYearLater = new Date(T0.getTime() + minutes(60 * 24 * 365));
    expect(canAttempt(openState, oneYearLater)).toBe(false);
    expect(shouldOpen(openState, oneYearLater)).toBe(false); // already open, nothing to "re-decide"
  });
});

describe("shouldOpen", () => {
  it("is false below the open threshold", () => {
    expect(shouldOpen(closed({ breakerFailureCount: 2, breakerFailureWindowStart: T0 }), T0)).toBe(false);
  });

  it("is true at the open threshold within a fresh window", () => {
    expect(shouldOpen(closed({ breakerFailureCount: 3, breakerFailureWindowStart: T0 }), T0)).toBe(true);
  });

  it("is false when the threshold is met but the window is stale", () => {
    const stale = new Date(T0.getTime() + minutes(31));
    expect(shouldOpen(closed({ breakerFailureCount: 3, breakerFailureWindowStart: T0 }), stale)).toBe(false);
  });

  it("is false when there is no window yet", () => {
    expect(shouldOpen(closed({ breakerFailureCount: 3, breakerFailureWindowStart: null }), T0)).toBe(false);
  });
});
