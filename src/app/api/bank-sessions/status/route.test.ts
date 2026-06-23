import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createGetBankSessionStatusHandler,
  type BankSessionStatusHandlerDeps,
} from "./route";
import type { BankSessionCheckResult, BankSessionMonitor } from "../../../../modules/bank-sessions";

// ---------------------------------------------------------------------------
// Fake checker and monitor
// ---------------------------------------------------------------------------

function makeStubChecker(result: BankSessionCheckResult): BankSessionStatusHandlerDeps["checker"] {
  return {
    async check(): Promise<BankSessionCheckResult> {
      return result;
    },
  };
}

function makeStubMonitor(lastResult: BankSessionCheckResult | null): BankSessionMonitor {
  return {
    async tick(): Promise<BankSessionCheckResult> {
      return lastResult ?? { status: "active", checkedAt: new Date().toISOString(), safeSummary: "Bank session is active" };
    },
    start() { /* no-op */ },
    stop() { /* no-op */ },
    lastResult(): BankSessionCheckResult | null {
      return lastResult;
    },
  };
}

const ACTIVE_RESULT: BankSessionCheckResult = {
  status: "active",
  checkedAt: "2026-01-01T00:00:00.000Z",
  safeSummary: "Bank session is active",
};

const EXPIRED_RESULT: BankSessionCheckResult = {
  status: "expired",
  checkedAt: "2026-01-01T00:00:00.000Z",
  safeSummary: "Bank session expired or requires verification",
};

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

function makeRequest(
  headers: Record<string, string> = {},
  searchParams: Record<string, string> = {},
): Request {
  const url = new URL("http://localhost/api/bank-sessions/status");
  for (const [k, v] of Object.entries(searchParams)) {
    url.searchParams.set(k, v);
  }
  return new Request(url.toString(), { headers });
}

function adminHeaders(): Record<string, string> {
  return { "x-rd-sync-user-id": "user-1", "x-rd-sync-role": "admin" };
}

function reviewerHeaders(): Record<string, string> {
  return { "x-rd-sync-user-id": "user-2", "x-rd-sync-role": "reviewer" };
}

// ---------------------------------------------------------------------------
// Auth matrix
// ---------------------------------------------------------------------------

describe("GET /api/bank-sessions/status — auth matrix", () => {
  beforeEach(() => {
    process.env.RD_SYNC_TRUST_PROXY_HEADERS = "enabled";
  });

  afterEach(() => {
    delete process.env.RD_SYNC_TRUST_PROXY_HEADERS;
  });
  it("returns 401 when no headers are provided", async () => {
    const handler = createGetBankSessionStatusHandler({
      checker: makeStubChecker(ACTIVE_RESULT),
      monitor: null,
    });

    const res = await handler(makeRequest());
    expect(res.status).toBe(401);
  });

  it("returns 403 when caller is a reviewer (not admin)", async () => {
    const handler = createGetBankSessionStatusHandler({
      checker: makeStubChecker(ACTIVE_RESULT),
      monitor: null,
    });

    const res = await handler(makeRequest(reviewerHeaders()));
    expect(res.status).toBe(403);
  });

  it("returns 200 when caller is an admin", async () => {
    const handler = createGetBankSessionStatusHandler({
      checker: makeStubChecker(ACTIVE_RESULT),
      monitor: null,
    });

    const res = await handler(makeRequest(adminHeaders()));
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// previewRole backdoor is removed — query params must never substitute for
// a real admin principal.
// ---------------------------------------------------------------------------

describe("GET /api/bank-sessions/status — previewRole bypass is removed", () => {
  beforeEach(() => {
    process.env.RD_SYNC_TRUST_PROXY_HEADERS = "enabled";
  });

  afterEach(() => {
    delete process.env.RD_SYNC_TRUST_PROXY_HEADERS;
  });

  it("returns 401 when only a previewRole=admin query param is provided", async () => {
    const handler = createGetBankSessionStatusHandler({
      checker: makeStubChecker(ACTIVE_RESULT),
      monitor: null,
    });

    const res = await handler(makeRequest({}, { previewRole: "admin" }));
    expect(res.status).toBe(401);
  });

  it("returns 401 with previewRole=viewer even when dev preview is enabled", async () => {
    const previousPreview = process.env.RD_SYNC_DEV_PREVIEW;
    try {
      process.env.RD_SYNC_DEV_PREVIEW = "enabled";
      const handler = createGetBankSessionStatusHandler({
        checker: makeStubChecker(ACTIVE_RESULT),
        monitor: null,
      });

      const res = await handler(makeRequest({}, { previewRole: "viewer" }));
      expect(res.status).toBe(401);
    } finally {
      if (previousPreview === undefined) {
        delete process.env.RD_SYNC_DEV_PREVIEW;
      } else {
        process.env.RD_SYNC_DEV_PREVIEW = previousPreview;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Response shape
// ---------------------------------------------------------------------------

describe("GET /api/bank-sessions/status — response shape", () => {
  beforeEach(() => {
    process.env.RD_SYNC_TRUST_PROXY_HEADERS = "enabled";
  });

  afterEach(() => {
    delete process.env.RD_SYNC_TRUST_PROXY_HEADERS;
  });
  it("includes session with live check result", async () => {
    const handler = createGetBankSessionStatusHandler({
      checker: makeStubChecker(EXPIRED_RESULT),
      monitor: null,
    });

    const res = await handler(makeRequest(adminHeaders()));
    const body = await res.json() as { session: BankSessionCheckResult; monitor: { enabled: boolean; lastResult: BankSessionCheckResult | null } };

    expect(body.session.status).toBe("expired");
    expect(body.session.safeSummary).toBe("Bank session expired or requires verification");
  });

  it("includes monitor.enabled=false when monitor is null", async () => {
    const handler = createGetBankSessionStatusHandler({
      checker: makeStubChecker(ACTIVE_RESULT),
      monitor: null,
    });

    const res = await handler(makeRequest(adminHeaders()));
    const body = await res.json() as { session: BankSessionCheckResult; monitor: { enabled: boolean; lastResult: null } };

    expect(body.monitor.enabled).toBe(false);
    expect(body.monitor.lastResult).toBeNull();
  });

  it("includes monitor.enabled=true and lastResult when monitor is provided", async () => {
    const handler = createGetBankSessionStatusHandler({
      checker: makeStubChecker(ACTIVE_RESULT),
      monitor: makeStubMonitor(EXPIRED_RESULT),
    });

    const res = await handler(makeRequest(adminHeaders()));
    const body = await res.json() as { session: BankSessionCheckResult; monitor: { enabled: boolean; lastResult: BankSessionCheckResult } };

    expect(body.monitor.enabled).toBe(true);
    expect(body.monitor.lastResult?.status).toBe("expired");
  });

  it("returns monitor.lastResult=null when monitor has not run a tick yet", async () => {
    const handler = createGetBankSessionStatusHandler({
      checker: makeStubChecker(ACTIVE_RESULT),
      monitor: makeStubMonitor(null),
    });

    const res = await handler(makeRequest(adminHeaders()));
    const body = await res.json() as { session: BankSessionCheckResult; monitor: { enabled: boolean; lastResult: null } };

    expect(body.monitor.lastResult).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Resilience: an unexpected throw from the checker must NOT take down the
// admin endpoint. The handler must degrade to browser_unavailable so
// operators still see a usable status.
// ---------------------------------------------------------------------------

describe("GET /api/bank-sessions/status — checker-throws resilience", () => {
  beforeEach(() => {
    process.env.RD_SYNC_TRUST_PROXY_HEADERS = "enabled";
  });

  afterEach(() => {
    delete process.env.RD_SYNC_TRUST_PROXY_HEADERS;
  });

  it("degrades to browser_unavailable when the checker throws unexpectedly", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const before = Date.now();
      const handler = createGetBankSessionStatusHandler({
        checker: {
          async check(): Promise<BankSessionCheckResult> {
            throw new Error("CDP page closed unexpectedly");
          },
        },
        monitor: null,
      });

      const res = await handler(makeRequest(adminHeaders()));

      // Endpoint stays 200 — the operator still gets a usable status.
      expect(res.status).toBe(200);
      const body = await res.json() as { session: BankSessionCheckResult };
      expect(body.session.status).toBe("browser_unavailable");
      expect(body.session.safeSummary).toBe("Bank browser session is not available");
      // The fallback checkedAt must be the current failure timestamp, NOT the
      // Unix epoch (new Date(0)). A 1970 timestamp would mislead operators
      // into thinking the checker last ran at the epoch.
      const checkedAtMs = new Date(body.session.checkedAt).getTime();
      expect(checkedAtMs).not.toBe(0);
      expect(checkedAtMs).toBeGreaterThanOrEqual(before);
      // Server-side diagnostic context is logged with the actor id so we
      // can correlate the failure with the caller.
      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const firstCall = consoleSpy.mock.calls[0];
      expect(String(firstCall?.[0] ?? "")).toContain("bank-sessions/status");
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("does not leak the raw checker error.message to the response body", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const handler = createGetBankSessionStatusHandler({
        checker: {
          async check(): Promise<BankSessionCheckResult> {
            throw new Error("Redis ECONNREFUSED secret-bucket-1:6379 password=hunter2");
          },
        },
        monitor: null,
      });

      const res = await handler(makeRequest(adminHeaders()));
      const text = await res.text();

      expect(res.status).toBe(200);
      expect(text).not.toContain("Redis");
      expect(text).not.toContain("ECONNREFUSED");
      expect(text).not.toContain("secret-bucket");
      expect(text).not.toContain("password");
      expect(text).not.toContain("hunter2");
    } finally {
      consoleSpy.mockRestore();
    }
  });
});
