/**
 * Verifies that all in-memory default singletons are anchored on globalThis so
 * every Next.js module graph (RSC, API route) shares the same instance in dev.
 *
 * Pattern: import module → mutate → vi.resetModules() → dynamic re-import →
 * assert the re-imported export reflects the earlier mutation (same object).
 *
 * afterEach clears the __rdSync* keys so each test starts from a clean slate.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const GLOBAL_KEYS = [
  "__rdSyncTransactionRepository",
  "__rdSyncScrapeRunRepository",
  "__rdSyncIngestionQueue",
  "__rdSyncAuditSink",
  "__rdSyncIngestionConsumer",
  "__rdSyncSessionMonitor",
  "__rdSyncBrowserCapacityMonitor",
] as const;

function clearGlobalSingletons() {
  for (const key of GLOBAL_KEYS) {
    delete (globalThis as Record<string, unknown>)[key];
  }
}

// ---------------------------------------------------------------------------
// Transaction repository — globalThis sharing
// ---------------------------------------------------------------------------

describe("defaultTransactionRepository — globalThis sharing", () => {
  beforeEach(() => {
    clearGlobalSingletons();
    vi.resetModules();
  });

  afterEach(() => {
    clearGlobalSingletons();
    vi.resetModules();
  });

  it("exposes the same repository instance after module reset (simulates two RSC graphs)", async () => {
    // Graph A
    const { defaultTransactionRepository: repoA } = await import(
      "./transactions/defaults"
    );

    // Upsert a transaction so we can detect whether graph B sees it
    const { normalizeBankMovement } = await import(
      "../../modules/transactions"
    );
    await repoA.upsertMany([
      normalizeBankMovement(
        {
          bankId: "popular",
          accountFingerprint: "acct-globalThis-test",
          postedAt: "2026-06-01T00:00:00-04:00",
          amount: "9.99",
          currency: "DOP",
          direction: "credit",
          reference: "GLOBAL-TEST-1",
          concept: null,
          originator: null,
        },
        { id: "tx-globalThis-check" },
      ),
    ]);

    // Simulate a second module graph by resetting and re-importing
    vi.resetModules();

    const { defaultTransactionRepository: repoB } = await import(
      "./transactions/defaults"
    );

    // Must be the SAME object (globalThis anchor)
    expect(repoB).toBe(repoA);

    // And must contain the data inserted via graph A
    const records = await repoB.list({});
    expect(records.some((r) => r.id === "tx-globalThis-check")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scrape-run repository — globalThis sharing
// ---------------------------------------------------------------------------

describe("defaultScrapeRunRepository — globalThis sharing", () => {
  beforeEach(() => {
    clearGlobalSingletons();
    vi.resetModules();
  });

  afterEach(() => {
    clearGlobalSingletons();
    vi.resetModules();
  });

  it("exposes the same repository instance after module reset", async () => {
    const { defaultScrapeRunRepository: repoA } = await import(
      "./scrape-runs/defaults"
    );

    await repoA.createQueued({
      id: "run-globalThis-check",
      bankId: "popular",
      createdAt: new Date(),
    });

    vi.resetModules();

    const { defaultScrapeRunRepository: repoB } = await import(
      "./scrape-runs/defaults"
    );

    expect(repoB).toBe(repoA);

    const records = await repoB.list({});
    expect(records.some((r) => r.id === "run-globalThis-check")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Ingestion queue — globalThis sharing
// ---------------------------------------------------------------------------

describe("defaultIngestionQueue — globalThis sharing", () => {
  beforeEach(() => {
    clearGlobalSingletons();
    vi.resetModules();
  });

  afterEach(() => {
    clearGlobalSingletons();
    vi.resetModules();
  });

  it("exposes the same queue instance after module reset", async () => {
    const { defaultIngestionQueue: queueA } = await import(
      "./scrape-runs/defaults"
    );

    await queueA.add(
      "bank-transaction-ingestion",
      { runId: "q-check", bankId: "popular", accountFingerprint: "fp-q" },
      { jobId: "q-check", attempts: 1 },
    );

    vi.resetModules();

    const { defaultIngestionQueue: queueB } = await import(
      "./scrape-runs/defaults"
    );

    expect(queueB).toBe(queueA);
    // Access .jobs via type assertion — this test runs without RD_SYNC_REDIS_URL
    // so the queue is always InMemoryScheduledIngestionQueue at runtime.
    // We cannot use instanceof after vi.resetModules() because the class
    // identity changes across module graph resets.
    expect((queueA as { jobs?: unknown[] }).jobs).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Audit sink — globalThis sharing
// ---------------------------------------------------------------------------

describe("defaultAuditSink — globalThis sharing", () => {
  beforeEach(() => {
    clearGlobalSingletons();
    vi.resetModules();
  });

  afterEach(() => {
    clearGlobalSingletons();
    vi.resetModules();
  });

  it("exposes the same sink instance after module reset", async () => {
    const { defaultAuditSink: sinkA } = await import("./audit/defaults");

    const { createAuditEvent } = await import("../../modules/audit");
    await sinkA.record(
      createAuditEvent({
        actorId: "sys",
        actorRole: "system",
        action: "test.globalThis",
        target: "audit",
      }),
    );

    vi.resetModules();

    const { defaultAuditSink: sinkB } = await import("./audit/defaults");

    expect(sinkB).toBe(sinkA);

    const events = await sinkB.list();
    expect(events.some((e) => e.action === "test.globalThis")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Ingestion consumer — globalThis sharing
// ---------------------------------------------------------------------------

describe("defaultIngestionConsumer — globalThis sharing", () => {
  beforeEach(() => {
    clearGlobalSingletons();
    vi.resetModules();
  });

  afterEach(() => {
    clearGlobalSingletons();
    vi.resetModules();
  });

  it("exposes the same consumer instance after module reset (no double-drain)", async () => {
    const { defaultIngestionConsumer: consumerA } = await import(
      "./scrape-runs/consumer-defaults"
    );

    vi.resetModules();

    const { defaultIngestionConsumer: consumerB } = await import(
      "./scrape-runs/consumer-defaults"
    );

    expect(consumerB).toBe(consumerA);
  });
});

// ---------------------------------------------------------------------------
// Session monitor — globalThis sharing + single-start guard
// ---------------------------------------------------------------------------

describe("defaultSessionMonitor — globalThis sharing and single-start guard", () => {
  beforeEach(() => {
    clearGlobalSingletons();
    vi.resetModules();
    // Ensure monitor is disabled by default so no real setInterval fires
    delete process.env.RD_SYNC_SESSION_MONITOR;
  });

  afterEach(() => {
    clearGlobalSingletons();
    vi.resetModules();
    delete process.env.RD_SYNC_SESSION_MONITOR;
    delete process.env.RD_SYNC_SCRAPER;
  });

  it("null monitor is shared across module graphs when disabled", async () => {
    const { defaultSessionMonitor: monitorA } = await import(
      "./bank-sessions/defaults"
    );

    vi.resetModules();

    const { defaultSessionMonitor: monitorB } = await import(
      "./bank-sessions/defaults"
    );

    // Both are null (monitor disabled) and refer to the same global slot
    expect(monitorA).toBeNull();
    expect(monitorB).toBeNull();
  });

  it("keeps the monitor dormant across module graphs even when the legacy env flag is enabled", async () => {
    process.env.RD_SYNC_SESSION_MONITOR = "enabled";

    const { defaultSessionMonitor: monitorA } =
      await import("./bank-sessions/defaults");

    vi.resetModules();

    const { defaultSessionMonitor: monitorB } =
      await import("./bank-sessions/defaults");

    expect(monitorB).toBe(monitorA);
    expect(monitorA).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Browser capacity monitor — globalThis sharing + single-start guard
// ---------------------------------------------------------------------------

describe("defaultBrowserCapacityMonitor — globalThis sharing and single-start guard", () => {
  beforeEach(() => {
    clearGlobalSingletons();
    vi.resetModules();
    delete process.env.RD_SYNC_BROWSER_CAPACITY_MONITOR;
  });

  afterEach(() => {
    clearGlobalSingletons();
    vi.resetModules();
    delete process.env.RD_SYNC_BROWSER_CAPACITY_MONITOR;
  });

  it("null monitor is shared across module graphs when disabled", async () => {
    const { defaultBrowserCapacityMonitor: monitorA } = await import(
      "./scrape-runs/consumer-defaults"
    );

    vi.resetModules();

    const { defaultBrowserCapacityMonitor: monitorB } = await import(
      "./scrape-runs/consumer-defaults"
    );

    expect(monitorA).toBeNull();
    expect(monitorB).toBeNull();
  });

  it("is idempotent across two module graphs (no double timer)", async () => {
    process.env.RD_SYNC_BROWSER_CAPACITY_MONITOR = "enabled";

    // Same rationale as the session monitor test above: the module-level
    // singleton is constructed and started at import time, so idempotency is
    // observed via the globalThis anchor reusing the SAME (already-started)
    // instance across a simulated second module graph.
    const { defaultBrowserCapacityMonitor: monitorA } = await import(
      "./scrape-runs/consumer-defaults"
    );

    expect(monitorA).not.toBeNull();
    monitorA?.start(); // second call must be a no-op (handle guard)

    vi.resetModules();

    const { defaultBrowserCapacityMonitor: monitorB } = await import(
      "./scrape-runs/consumer-defaults"
    );

    expect(monitorB).toBe(monitorA);

    monitorA?.stop();
  });
});
