import { afterEach, describe, expect, it } from "vitest";

import {
  checkPopularSessionHealth,
  createBankSessionMonitor,
  createCdpSessionChecker,
  type BankSessionCheckResult,
  type BankSessionMonitorDeps,
  type BankSessionStatus,
  type CdpBrowserLike,
  type SessionProbePage,
} from "./index";

// ---------------------------------------------------------------------------
// FakeSessionProbePage — implements SessionProbePage seam
// ---------------------------------------------------------------------------

class FakeSessionProbePage implements SessionProbePage {
  readonly operations: string[] = [];

  constructor(
    private readonly state: {
      urlAfterGoto: string;
      waitForVisibleTextResult: boolean;
    },
  ) {}

  async goto(url: string): Promise<void> {
    this.operations.push(`goto:${url}`);
  }

  async currentUrl(): Promise<string> {
    this.operations.push("currentUrl");
    return this.state.urlAfterGoto;
  }

  async waitForVisibleText(text: string, timeoutMs: number): Promise<boolean> {
    this.operations.push(`waitForVisibleText:${text}:${timeoutMs}`);
    return this.state.waitForVisibleTextResult;
  }
}

// ---------------------------------------------------------------------------
// Fake alert sink
// ---------------------------------------------------------------------------

interface AlertCall {
  status: BankSessionStatus;
  safeSummary: string;
  checkedAt: string;
}

function makeAlertSink(): {
  sink: { notifySessionAttention: (event: AlertCall) => Promise<void> };
  calls: AlertCall[];
} {
  const calls: AlertCall[] = [];
  const sink = {
    async notifySessionAttention(event: AlertCall): Promise<void> {
      calls.push(event);
    },
  };
  return { sink, calls };
}

function makeThrowingAlertSink(): { notifySessionAttention: (event: AlertCall) => Promise<void> } {
  return {
    async notifySessionAttention(): Promise<void> {
      throw new Error("alert failed");
    },
  };
}

// ---------------------------------------------------------------------------
// Fake audit sink
// ---------------------------------------------------------------------------

import type { AuditEvent, AuditSink } from "../audit";

function makeAuditSink(): { sink: AuditSink; events: AuditEvent[] } {
  const events: AuditEvent[] = [];
  const sink: AuditSink = {
    async record(event: AuditEvent): Promise<void> {
      events.push(event);
    },
    async list(): Promise<AuditEvent[]> {
      return [...events];
    },
  };
  return { sink, events };
}

function makeThrowingAuditSink(): AuditSink {
  return {
    async record(): Promise<void> {
      throw new Error("audit failed");
    },
    async list(): Promise<AuditEvent[]> {
      return [];
    },
  };
}

// ---------------------------------------------------------------------------
// Fake scheduler (never waits real time)
// ---------------------------------------------------------------------------

interface FakeScheduler {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schedule: (fn: () => void, ms: number) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  clearSchedule: (handle: any) => void;
  tick(): void;
  callCount(): number;
}

function makeFakeScheduler(): FakeScheduler {
  let fn: (() => void) | null = null;
  let count = 0;

  return {
    schedule(cb: () => void) {
      fn = cb;
      return 1;
    },
    clearSchedule() {
      fn = null;
    },
    tick() {
      if (fn) {
        count++;
        fn();
      }
    },
    callCount() {
      return count;
    },
  };
}

// ---------------------------------------------------------------------------
// checkPopularSessionHealth
// ---------------------------------------------------------------------------

describe("checkPopularSessionHealth — active session", () => {
  it("returns active when URL includes /dashboard and Producto is visible", async () => {
    const page = new FakeSessionProbePage({
      urlAfterGoto: "https://ib.bpd.com.do/dashboard",
      waitForVisibleTextResult: true,
    });
    const result = await checkPopularSessionHealth(page, {
      baseUrl: "https://ib.bpd.com.do",
      clock: () => new Date("2026-01-01T00:00:00.000Z"),
    });

    expect(result.status).toBe("active");
    expect(result.safeSummary).toBe("Bank session is active");
    expect(result.checkedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("navigates to {baseUrl}/dashboard", async () => {
    const page = new FakeSessionProbePage({
      urlAfterGoto: "https://ib.bpd.com.do/dashboard",
      waitForVisibleTextResult: true,
    });
    await checkPopularSessionHealth(page, { baseUrl: "https://ib.bpd.com.do" });

    expect(page.operations[0]).toBe("goto:https://ib.bpd.com.do/dashboard");
  });
});

describe("checkPopularSessionHealth — expired: redirect", () => {
  it("returns expired when currentUrl does not include /dashboard", async () => {
    const page = new FakeSessionProbePage({
      urlAfterGoto: "https://ib.bpd.com.do/login",
      waitForVisibleTextResult: true,
    });
    const result = await checkPopularSessionHealth(page);

    expect(result.status).toBe("expired");
    expect(result.safeSummary).toBe("Bank session expired or requires verification");
  });
});

describe("checkPopularSessionHealth — expired: Producto not visible", () => {
  it("returns expired when waitForVisibleText('Producto') returns false", async () => {
    const page = new FakeSessionProbePage({
      urlAfterGoto: "https://ib.bpd.com.do/dashboard",
      waitForVisibleTextResult: false,
    });
    const result = await checkPopularSessionHealth(page);

    expect(result.status).toBe("expired");
    expect(result.safeSummary).toBe("Bank session expired or requires verification");
  });

  it("waits for text 'Producto' (not any other text)", async () => {
    const page = new FakeSessionProbePage({
      urlAfterGoto: "https://ib.bpd.com.do/dashboard",
      waitForVisibleTextResult: true,
    });
    await checkPopularSessionHealth(page, { waitTimeoutMs: 5000 });

    const waitOp = page.operations.find((op) => op.startsWith("waitForVisibleText:"));
    expect(waitOp).toContain("Producto");
    expect(waitOp).toContain("5000");
  });
});

// ---------------------------------------------------------------------------
// createCdpSessionChecker
// ---------------------------------------------------------------------------

describe("createCdpSessionChecker — connect failure", () => {
  it("returns browser_unavailable without throwing when connect rejects", async () => {
    const checker = createCdpSessionChecker({
      connect: async () => {
        throw new Error("ECONNREFUSED");
      },
    });

    const result = await checker.check();
    expect(result.status).toBe("browser_unavailable");
    expect(result.safeSummary).toBe("Bank browser session is not available");
  });

  it("never throws — check() always resolves", async () => {
    const checker = createCdpSessionChecker({
      connect: async () => {
        throw new Error("network failure");
      },
    });

    await expect(checker.check()).resolves.toBeDefined();
  });
});

describe("createCdpSessionChecker — cleanup in finally", () => {
  it("closes page and browser even when check throws internally", async () => {
    const pageCloses: number[] = [];
    const browserCloses: number[] = [];

    const fakePage: import("../../worker/scraper/navigation/popular-cdp").CdpPageLike = {
      url: () => "https://ib.bpd.com.do/dashboard",
      goto: async () => {
        throw new Error("navigation error");
      },
      waitForSelector: async () => undefined,
      waitForTimeout: async () => undefined,
      evaluate: async <T>() => null as unknown as T,
      close: async () => {
        pageCloses.push(1);
      },
    };

    const fakeBrowser: CdpBrowserLike = {
      contexts: () => [{ newPage: async () => fakePage }],
      newPage: async () => fakePage,
      close: async () => {
        browserCloses.push(1);
      },
    };

    const checker = createCdpSessionChecker({
      connect: async () => fakeBrowser as CdpBrowserLike,
    });

    // Should not throw
    await checker.check().catch(() => undefined);

    expect(pageCloses.length).toBeGreaterThan(0);
    expect(browserCloses.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// createBankSessionMonitor — transition matrix
// ---------------------------------------------------------------------------

function makeMonitorDeps(
  statuses: BankSessionStatus[],
  overrides: Partial<BankSessionMonitorDeps> = {},
): {
  deps: BankSessionMonitorDeps;
  alert: ReturnType<typeof makeAlertSink>;
  audit: ReturnType<typeof makeAuditSink>;
} {
  const alert = makeAlertSink();
  const audit = makeAuditSink();
  let index = 0;

  const deps: BankSessionMonitorDeps = {
    check: async (): Promise<BankSessionCheckResult> => {
      const status = statuses[index] ?? statuses[statuses.length - 1] ?? "active";
      index++;
      return {
        status,
        checkedAt: new Date().toISOString(),
        safeSummary:
          status === "active"
            ? "Bank session is active"
            : status === "expired"
              ? "Bank session expired or requires verification"
              : "Bank browser session is not available",
      };
    },
    alertSink: alert.sink,
    auditSink: audit.sink,
    intervalMs: 1000,
    ...overrides,
  };

  return { deps, alert, audit };
}

describe("createBankSessionMonitor — null → expired alerts once", () => {
  it("alerts on first expired check (transition from null)", async () => {
    const { deps, alert } = makeMonitorDeps(["expired"]);
    const monitor = createBankSessionMonitor(deps);

    await monitor.tick();

    expect(alert.calls).toHaveLength(1);
    expect(alert.calls[0].status).toBe("expired");
  });
});

describe("createBankSessionMonitor — expired → expired is silent", () => {
  it("does not re-alert on repeated expired state", async () => {
    const { deps, alert } = makeMonitorDeps(["expired", "expired"]);
    const monitor = createBankSessionMonitor(deps);

    await monitor.tick();
    await monitor.tick();

    expect(alert.calls).toHaveLength(1); // only the first transition
  });
});

describe("createBankSessionMonitor — expired → active alerts recovery", () => {
  it("alerts on recovery from expired to active", async () => {
    const { deps, alert } = makeMonitorDeps(["expired", "active"]);
    const monitor = createBankSessionMonitor(deps);

    await monitor.tick(); // expired — alert
    await monitor.tick(); // active — recovery alert

    expect(alert.calls).toHaveLength(2);
    expect(alert.calls[1].status).toBe("active");
  });
});

describe("createBankSessionMonitor — active → active is silent", () => {
  it("does not alert on repeated active state", async () => {
    const { deps, alert } = makeMonitorDeps(["active", "active"]);
    const monitor = createBankSessionMonitor(deps);

    await monitor.tick();
    await monitor.tick();

    expect(alert.calls).toHaveLength(0);
  });
});

describe("createBankSessionMonitor — null → browser_unavailable alerts", () => {
  it("alerts on first unavailable check", async () => {
    const { deps, alert } = makeMonitorDeps(["browser_unavailable"]);
    const monitor = createBankSessionMonitor(deps);

    await monitor.tick();

    expect(alert.calls).toHaveLength(1);
    expect(alert.calls[0].status).toBe("browser_unavailable");
  });
});

describe("createBankSessionMonitor — browser_unavailable → browser_unavailable is silent", () => {
  it("does not re-alert on repeated unavailable state", async () => {
    const { deps, alert } = makeMonitorDeps(["browser_unavailable", "browser_unavailable"]);
    const monitor = createBankSessionMonitor(deps);

    await monitor.tick();
    await monitor.tick();

    expect(alert.calls).toHaveLength(1);
  });
});

describe("createBankSessionMonitor — audit events on transitions only", () => {
  it("emits bank_session.expired audit event on expired transition", async () => {
    const { deps, audit } = makeMonitorDeps(["expired"]);
    const monitor = createBankSessionMonitor(deps);

    await monitor.tick();

    expect(audit.events).toHaveLength(1);
    expect(audit.events[0].action).toBe("bank_session.expired");
    expect(audit.events[0].actorId).toBe("system:session-monitor");
  });

  it("emits bank_session.restored audit event on recovery", async () => {
    const { deps, audit } = makeMonitorDeps(["expired", "active"]);
    const monitor = createBankSessionMonitor(deps);

    await monitor.tick();
    await monitor.tick();

    expect(audit.events).toHaveLength(2);
    expect(audit.events[1].action).toBe("bank_session.restored");
  });

  it("emits bank_session.unavailable audit event on unavailable transition", async () => {
    const { deps, audit } = makeMonitorDeps(["browser_unavailable"]);
    const monitor = createBankSessionMonitor(deps);

    await monitor.tick();

    expect(audit.events[0].action).toBe("bank_session.unavailable");
  });

  it("does not emit audit on silent repeated bad state", async () => {
    const { deps, audit } = makeMonitorDeps(["expired", "expired"]);
    const monitor = createBankSessionMonitor(deps);

    await monitor.tick();
    await monitor.tick();

    expect(audit.events).toHaveLength(1);
  });

  it("does not emit audit on repeated active state", async () => {
    const { deps, audit } = makeMonitorDeps(["active", "active"]);
    const monitor = createBankSessionMonitor(deps);

    await monitor.tick();
    await monitor.tick();

    expect(audit.events).toHaveLength(0);
  });
});

describe("createBankSessionMonitor — throwing sinks do not break tick", () => {
  it("tick() resolves when alert sink throws", async () => {
    const { deps } = makeMonitorDeps(["expired"]);
    const monitor = createBankSessionMonitor({
      ...deps,
      alertSink: makeThrowingAlertSink(),
    });

    await expect(monitor.tick()).resolves.toBeDefined();
  });

  it("tick() resolves when audit sink throws", async () => {
    const { deps } = makeMonitorDeps(["expired"]);
    const monitor = createBankSessionMonitor({
      ...deps,
      auditSink: makeThrowingAuditSink(),
    });

    await expect(monitor.tick()).resolves.toBeDefined();
  });
});

describe("createBankSessionMonitor — start/stop idempotency", () => {
  it("start() is idempotent — calling twice registers only one interval", () => {
    const scheduler = makeFakeScheduler();
    const { deps } = makeMonitorDeps(["active"]);
    const monitor = createBankSessionMonitor({
      ...deps,
      schedule: scheduler.schedule,
      clearSchedule: scheduler.clearSchedule,
    });

    monitor.start();
    monitor.start(); // should be a no-op

    scheduler.tick();

    // Only one scheduled run means one tick was fired
    expect(scheduler.callCount()).toBe(1);
  });

  it("stop() clears the interval so no further ticks fire", () => {
    const scheduler = makeFakeScheduler();
    const { deps } = makeMonitorDeps(["active", "expired"]);
    const { alert } = makeMonitorDeps(["active", "expired"]);
    const monitor = createBankSessionMonitor({
      ...deps,
      alertSink: alert.sink,
      schedule: scheduler.schedule,
      clearSchedule: scheduler.clearSchedule,
    });

    monitor.start();
    monitor.stop();
    scheduler.tick(); // should not fire — handle was cleared

    expect(scheduler.callCount()).toBe(0);
  });

  it("stop() is idempotent — calling twice does not throw", () => {
    const scheduler = makeFakeScheduler();
    const { deps } = makeMonitorDeps(["active"]);
    const monitor = createBankSessionMonitor({
      ...deps,
      schedule: scheduler.schedule,
      clearSchedule: scheduler.clearSchedule,
    });

    monitor.start();
    expect(() => {
      monitor.stop();
      monitor.stop();
    }).not.toThrow();
  });
});

describe("createBankSessionMonitor — lastResult", () => {
  it("returns null before first tick", () => {
    const { deps } = makeMonitorDeps(["active"]);
    const monitor = createBankSessionMonitor(deps);
    expect(monitor.lastResult()).toBeNull();
  });

  it("returns the most recent check result after a tick", async () => {
    const { deps } = makeMonitorDeps(["expired"]);
    const monitor = createBankSessionMonitor(deps);
    await monitor.tick();
    expect(monitor.lastResult()?.status).toBe("expired");
  });
});

// ---------------------------------------------------------------------------
// createBankSessionMonitor — bad→different-bad flapping does not re-alert
// ---------------------------------------------------------------------------

describe("createBankSessionMonitor — bad→different-bad flapping is silent", () => {
  it("does not re-alert when state alternates between expired and browser_unavailable", async () => {
    const { deps, alert } = makeMonitorDeps([
      "expired",
      "browser_unavailable",
      "expired",
    ]);
    const monitor = createBankSessionMonitor(deps);

    await monitor.tick(); // null → expired: alert
    await monitor.tick(); // expired → browser_unavailable: silent (still bad)
    await monitor.tick(); // browser_unavailable → expired: silent (still bad)

    expect(alert.calls).toHaveLength(1);
    expect(alert.calls[0].status).toBe("expired");
  });

  it("alerts again only once the session recovers then goes bad again", async () => {
    const { deps, alert } = makeMonitorDeps([
      "expired",
      "active",
      "browser_unavailable",
    ]);
    const monitor = createBankSessionMonitor(deps);

    await monitor.tick(); // null → expired: alert (bad)
    await monitor.tick(); // expired → active: alert (recovery)
    await monitor.tick(); // active → browser_unavailable: alert (new bad from active)

    expect(alert.calls).toHaveLength(3);
    expect(alert.calls[2].status).toBe("browser_unavailable");
  });
});

// ---------------------------------------------------------------------------
// createBankSessionMonitor — clock injection in unexpected-throw fallback
// ---------------------------------------------------------------------------

describe("createBankSessionMonitor — clock used in unexpected-throw fallback", () => {
  it("uses the injected clock for checkedAt when check() throws unexpectedly", async () => {
    const { alert } = makeMonitorDeps([]);
    const fixedTime = "2030-06-15T12:00:00.000Z";
    const clock = () => new Date(fixedTime);

    const deps: BankSessionMonitorDeps = {
      check: async () => { throw new Error("unexpected"); },
      alertSink: alert.sink,
      intervalMs: 1000,
      clock,
    };

    const monitor = createBankSessionMonitor(deps);
    const result = await monitor.tick();

    expect(result.status).toBe("browser_unavailable");
    expect(result.checkedAt).toBe(fixedTime);
  });
});

// ---------------------------------------------------------------------------
// env cleanup (afterEach guard)
// ---------------------------------------------------------------------------

afterEach(() => {
  // No env vars used in the core module tests, but guard pattern is mirrored.
});
