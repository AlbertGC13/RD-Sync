import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createGetBankSessionStatusHandler,
  resolveApiPreviewPrincipal,
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
// Dev preview principal — gated by NODE_ENV and RD_SYNC_DEV_PREVIEW
// ---------------------------------------------------------------------------

describe("GET /api/bank-sessions/status — dev preview principal", () => {
  beforeEach(() => {
    process.env.RD_SYNC_DEV_PREVIEW = "enabled";
  });

  afterEach(() => {
    delete process.env.RD_SYNC_DEV_PREVIEW;
    // NODE_ENV is read-only at the type level; no cleanup needed
  });

  it("returns 200 with previewRole=admin when dev preview is enabled", async () => {
    const handler = createGetBankSessionStatusHandler({
      checker: makeStubChecker(ACTIVE_RESULT),
      monitor: null,
    });

    const res = await handler(makeRequest({}, { previewRole: "admin" }));
    expect(res.status).toBe(200);
  });

  it("returns 401 with previewRole=viewer (not admin role)", async () => {
    const handler = createGetBankSessionStatusHandler({
      checker: makeStubChecker(ACTIVE_RESULT),
      monitor: null,
    });

    const res = await handler(makeRequest({}, { previewRole: "viewer" }));
    // previewRole=viewer does not resolve a principal, so 401
    expect(res.status).toBe(401);
  });

  it("production ignores the dev preview flag — resolveApiPreviewPrincipal returns null", () => {
    withEnv({ NODE_ENV: "production", RD_SYNC_DEV_PREVIEW: "enabled" }, () => {
      expect(resolveApiPreviewPrincipal(new URLSearchParams("previewRole=admin"))).toBeNull();
    });
  });

  it("production rejects previewRole=admin via the full handler (returns 401)", async () => {
    const handler = createGetBankSessionStatusHandler({
      checker: makeStubChecker(ACTIVE_RESULT),
      monitor: null,
    });

    const res = await withEnv(
      { NODE_ENV: "production", RD_SYNC_DEV_PREVIEW: "enabled" },
      () => handler(makeRequest({}, { previewRole: "admin" })),
    );
    expect(res.status).toBe(401);
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
// env cleanup
// ---------------------------------------------------------------------------

afterEach(() => {
  delete process.env.RD_SYNC_DEV_PREVIEW;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withEnv<T>(values: Record<string, string | undefined>, callback: () => T): T {
  const previous = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  ) as Record<string, string | undefined>;

  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return callback();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
