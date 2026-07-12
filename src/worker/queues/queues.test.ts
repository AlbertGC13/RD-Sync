import { describe, expect, it, vi } from "vitest";

import {
  createIngestionProcessor,
  createIngestionQueueOptions,
  scheduleIngestionJob,
  type IngestionJobData,
  type ResolveScraper,
  type ScrapeRunStatus,
} from "./index";
import type { BankMovement } from "../../modules/transactions";
import { InMemoryAuditSink } from "../../modules/audit";

const jobData: IngestionJobData = {
  runId: "run-1",
  bankId: "popular",
  accountFingerprint: "acct-main",
};

describe("ingestion processor", () => {
  it("marks a run succeeded with inserted and skipped transaction counts", async () => {
    const movements: BankMovement[] = [
      {
        bankId: "popular",
        accountFingerprint: "acct-main",
        postedAt: "2026-06-07T13:45:00.000Z",
        amount: "1500.50",
        currency: "DOP",
        direction: "credit",
        reference: "REF-123",
      },
      {
        bankId: "popular",
        accountFingerprint: "acct-main",
        postedAt: "2026-06-07T14:00:00.000Z",
        amount: "1500.50",
        currency: "DOP",
        direction: "credit",
        reference: "REF-123",
      },
    ];
    const scrapeRuns = new FakeScrapeRunRepository();
    const transactions = new FakeTransactionRepository({ inserted: 1, skipped: 1 });
    const processor = createIngestionProcessor({
      scrapeRuns,
      transactions,
      scraper: { collect: async () => ({ status: "collected", movements }) },
    });

    const result = await processor({ data: jobData });

    expect(result).toEqual({ status: "succeeded", inserted: 1, skipped: 1 });
    expect(scrapeRuns.transitions).toEqual([
      { runId: "run-1", status: "running" },
      { runId: "run-1", status: "succeeded", insertedCount: 1, skippedCount: 1 },
    ]);
    expect(transactions.received).toHaveLength(2);
    expect(transactions.received.map((record) => record.scrapeRunId)).toEqual(["run-1", "run-1"]);
    expect(new Set(transactions.received.map((record) => record.sourceHash)).size).toBe(2);
  });

  it("pauses the run for admin action when the scraper reports MFA", async () => {
    const scrapeRuns = new FakeScrapeRunRepository();
    const transactions = new FakeTransactionRepository({ inserted: 0, skipped: 0 });
    const adminAlerts = new FakeAdminAlertSink();
    const processor = createIngestionProcessor({
      scrapeRuns,
      transactions,
      adminAlerts,
      scraper: {
        collect: async () => ({
          status: "needs_admin_action",
          movements: [],
          safeErrorSummary: "Bank session requires admin MFA action",
        }),
      },
    });

    const result = await processor({ data: jobData });

    expect(result).toEqual({ status: "needs_admin_action", inserted: 0, skipped: 0 });
    expect(scrapeRuns.transitions).toEqual([
      { runId: "run-1", status: "running" },
      {
        runId: "run-1",
        status: "needs_admin_action",
        safeErrorSummary: "Bank session requires admin MFA action",
      },
    ]);
    expect(transactions.received).toEqual([]);
    expect(adminAlerts.events).toEqual([
      {
        runId: "run-1",
        bankId: "popular",
        status: "needs_admin_action",
        safeErrorSummary: "Bank session requires admin MFA action",
      },
    ]);
  });

  it("records a safe failure summary without leaking secrets", async () => {
    const scrapeRuns = new FakeScrapeRunRepository();
    const adminAlerts = new FakeAdminAlertSink();
    const processor = createIngestionProcessor({
      scrapeRuns,
      adminAlerts,
      transactions: new FakeTransactionRepository({ inserted: 0, skipped: 0 }),
      scraper: {
        collect: async () => {
          throw new Error("selector missing token=secret password=abc account 0012345678901");
        },
      },
    });

    const result = await processor({ data: jobData });

    expect(result).toEqual({ status: "failed", inserted: 0, skipped: 0 });
    expect(scrapeRuns.transitions).toEqual([
      { runId: "run-1", status: "running" },
      {
        runId: "run-1",
        status: "failed",
        safeErrorSummary: "selector missing [REDACTED] [REDACTED] account [REDACTED_ACCOUNT]",
      },
    ]);
    expect(adminAlerts.events).toEqual([
      {
        runId: "run-1",
        bankId: "popular",
        status: "failed",
        safeErrorSummary: "selector missing [REDACTED] [REDACTED] account [REDACTED_ACCOUNT]",
      },
    ]);
  });
});

describe("ingestion processor — audit events", () => {
  it("emits scrape_run.started then scrape_run.succeeded with inserted and skipped counts", async () => {
    const movements: BankMovement[] = [
      {
        bankId: "popular",
        accountFingerprint: "acct-main",
        postedAt: "2026-06-07T13:45:00.000Z",
        amount: "1500.50",
        currency: "DOP",
        direction: "credit",
        reference: "REF-A",
      },
    ];
    const auditSink = new InMemoryAuditSink();
    const processor = createIngestionProcessor({
      scrapeRuns: new FakeScrapeRunRepository(),
      transactions: new FakeTransactionRepository({ inserted: 1, skipped: 0 }),
      scraper: { collect: async () => ({ status: "collected", movements }) },
      auditSink,
    });

    await processor({ data: jobData });

    const events = await auditSink.list();
    expect(events).toHaveLength(2);
    // list() returns newest-first; find by action to remain order-independent.
    const startedEvent = events.find((e) => e.action === "scrape_run.started");
    const succeededEvent = events.find((e) => e.action === "scrape_run.succeeded");
    expect(startedEvent).toMatchObject({
      actorId: "system:ingestion-worker",
      action: "scrape_run.started",
      target: "scrape_run",
      targetId: "run-1",
      metadata: { bankId: "popular" },
    });
    expect(succeededEvent).toMatchObject({
      actorId: "system:ingestion-worker",
      action: "scrape_run.succeeded",
      target: "scrape_run",
      targetId: "run-1",
      metadata: { bankId: "popular", inserted: 1, skipped: 0 },
    });
  });

  it("emits scrape_run.started then scrape_run.needs_admin_action with safe summary", async () => {
    const auditSink = new InMemoryAuditSink();
    const processor = createIngestionProcessor({
      scrapeRuns: new FakeScrapeRunRepository(),
      transactions: new FakeTransactionRepository({ inserted: 0, skipped: 0 }),
      scraper: {
        collect: async () => ({
          status: "needs_admin_action",
          movements: [],
          safeErrorSummary: "Bank session requires admin MFA action",
        }),
      },
      auditSink,
    });

    await processor({ data: jobData });

    const events = await auditSink.list();
    expect(events).toHaveLength(2);
    // list() returns newest-first; find by action to remain order-independent.
    expect(events.find((e) => e.action === "scrape_run.started")).toMatchObject({ targetId: "run-1" });
    expect(events.find((e) => e.action === "scrape_run.needs_admin_action")).toMatchObject({
      targetId: "run-1",
      metadata: { bankId: "popular", safeErrorSummary: "Bank session requires admin MFA action" },
    });
  });

  it("emits scrape_run.failed without raw secret text", async () => {
    const auditSink = new InMemoryAuditSink();
    const processor = createIngestionProcessor({
      scrapeRuns: new FakeScrapeRunRepository(),
      transactions: new FakeTransactionRepository({ inserted: 0, skipped: 0 }),
      scraper: {
        collect: async () => {
          throw new Error("selector missing token=secret password=abc account 0012345678901");
        },
      },
      auditSink,
    });

    await processor({ data: jobData });

    const events = await auditSink.list();
    expect(events).toHaveLength(2);
    // list() returns newest-first; find by action to remain order-independent.
    const failedEvent = events.find((e) => e.action === "scrape_run.failed");
    expect(failedEvent).toMatchObject({
      action: "scrape_run.failed",
      targetId: "run-1",
      metadata: {
        bankId: "popular",
        safeErrorSummary: "selector missing [REDACTED] [REDACTED] account [REDACTED_ACCOUNT]",
      },
    });
    const failedMetadata = failedEvent?.metadata as Record<string, unknown>;
    expect(JSON.stringify(failedMetadata)).not.toContain("secret");
    expect(JSON.stringify(failedMetadata)).not.toContain("abc");
  });

  it("does not change the processor result when the audit sink throws", async () => {
    const throwingSink = {
      record: async () => {
        throw new Error("sink unavailable");
      },
    };
    const scrapeRuns = new FakeScrapeRunRepository();
    const processor = createIngestionProcessor({
      scrapeRuns,
      transactions: new FakeTransactionRepository({ inserted: 1, skipped: 0 }),
      scraper: {
        collect: async () => ({
          status: "collected",
          movements: [
            {
              bankId: "popular",
              accountFingerprint: "acct-main",
              postedAt: "2026-06-07T13:45:00.000Z",
              amount: "100.00",
              currency: "DOP",
              direction: "credit",
              reference: "REF-B",
            },
          ],
        }),
      },
      auditSink: throwingSink,
    });

    const result = await processor({ data: jobData });

    expect(result).toEqual({ status: "succeeded", inserted: 1, skipped: 0 });
    // Run state must also be unaffected — no spurious markFailed transition.
    expect(scrapeRuns.transitions).toEqual([
      { runId: "run-1", status: "running" },
      { runId: "run-1", status: "succeeded", insertedCount: 1, skippedCount: 0 },
    ]);
  });

  it("does not propagate a sink throw from the scrape_run.started emission (outside try block)", async () => {
    // emitAuditEvent for scrape_run.started sits OUTSIDE the processor's try/catch.
    // Verify that emitAuditEvent's own internal guard covers this placement:
    // the run must still reach 'succeeded' and markFailed must never be called.
    const throwingSink = {
      record: async () => {
        throw new Error("sink unavailable on started");
      },
    };
    const scrapeRuns = new FakeScrapeRunRepository();
    const processor = createIngestionProcessor({
      scrapeRuns,
      transactions: new FakeTransactionRepository({ inserted: 1, skipped: 1 }),
      scraper: {
        collect: async () => ({
          status: "collected",
          movements: [
            {
              bankId: "popular",
              accountFingerprint: "acct-main",
              postedAt: "2026-06-07T13:45:00.000Z",
              amount: "100.00",
              currency: "DOP",
              direction: "credit",
              reference: "REF-B",
            },
          ],
        }),
      },
      auditSink: throwingSink,
    });

    const result = await processor({ data: jobData });

    expect(result).toEqual({ status: "succeeded", inserted: 1, skipped: 1 });
    // Only running → succeeded; markFailed must never have been called.
    expect(scrapeRuns.transitions).toEqual([
      { runId: "run-1", status: "running" },
      { runId: "run-1", status: "succeeded", insertedCount: 1, skippedCount: 1 },
    ]);
  });

  it("works normally when no audit sink is provided", async () => {
    const processor = createIngestionProcessor({
      scrapeRuns: new FakeScrapeRunRepository(),
      transactions: new FakeTransactionRepository({ inserted: 0, skipped: 0 }),
      scraper: { collect: async () => ({ status: "collected", movements: [] }) },
    });

    const result = await processor({ data: jobData });

    expect(result).toEqual({ status: "succeeded", inserted: 0, skipped: 0 });
  });
});

describe("BullMQ ingestion scheduling", () => {
  it("uses stable job ids and retry/backoff options", async () => {
    const queue = new FakeQueue();

    await scheduleIngestionJob(queue, jobData);

    expect(queue.addCalls).toEqual([
      {
        name: "bank-transaction-ingestion",
        data: jobData,
        options: {
          jobId: "run-1",
          attempts: 3,
          backoff: { type: "exponential", delay: 30_000 },
          removeOnComplete: 100,
          removeOnFail: 250,
        },
      },
    ]);
    expect(createIngestionQueueOptions("run-2").jobId).toBe("run-2");
  });
});

// ---------------------------------------------------------------------------
// resolveScraper routing — BLOCKER fix coverage.
//
// These tests prove the processor actually routes by job.data.bankId via
// the resolveScraper dependency, NOT by a single scraper injected at
// construction time. This is the runtime path the reviewer flagged: the
// in-memory consumer and the BullMQ worker both call the processor with
// job.data.bankId, so the processor must resolve the scraper per job.
// ---------------------------------------------------------------------------

describe("ingestion processor — resolveScraper routing", () => {
  const popularMovements: BankMovement[] = [
    {
      bankId: "popular",
      accountFingerprint: "acct-main",
      postedAt: "2026-06-07T13:45:00.000Z",
      amount: "100.00",
      currency: "DOP",
      direction: "credit",
      reference: "REF-POP",
    },
  ];

  it("resolves the scraper by job.data.bankId and processes with the bank-specific scraper", async () => {
    const scrapeRuns = new FakeScrapeRunRepository();
    const transactions = new FakeTransactionRepository({ inserted: 1, skipped: 0 });
    const resolveScraper: ResolveScraper = (bankCode) => ({
      collect: async () => ({
        status: "collected" as const,
        movements: popularMovements.map((m) => ({ ...m, bankId: bankCode ?? "popular" })),
      }),
    });

    const processor = createIngestionProcessor({
      scrapeRuns,
      transactions,
      resolveScraper,
    });

    const result = await processor({
      data: { runId: "run-routing", bankId: "popular", accountFingerprint: "acct-main" },
    });

    expect(result).toEqual({ status: "succeeded", inserted: 1, skipped: 0 });
    expect(transactions.received[0]?.bankId).toBe("popular");
  });

  it("fails closed for an explicit unknown bankCode (needs_admin_action, no Popular fallback)", async () => {
    const scrapeRuns = new FakeScrapeRunRepository();
    const resolveScraper: ResolveScraper = (bankCode) => {
      if (bankCode && bankCode !== "popular") {
        return {
          collect: async () => ({
            status: "needs_admin_action" as const,
            movements: [],
            safeErrorSummary: "Bank not configured for automated scraping",
          }),
        };
      }
      return {
        collect: async () => ({
          status: "collected" as const,
          movements: popularMovements,
        }),
      };
    };

    const processor = createIngestionProcessor({
      scrapeRuns,
      transactions: new FakeTransactionRepository({ inserted: 0, skipped: 0 }),
      resolveScraper,
    });

    const result = await processor({
      data: { runId: "run-unknown", bankId: "banreservas", accountFingerprint: "acct-main" },
    });

    expect(result).toEqual({ status: "needs_admin_action", inserted: 0, skipped: 0 });
    expect(scrapeRuns.transitions).toEqual([
      { runId: "run-unknown", status: "running" },
      {
        runId: "run-unknown",
        status: "needs_admin_action",
        safeErrorSummary: "Bank not configured for automated scraping",
      },
    ]);
  });

  it("defaults to Popular when job.data.bankId is empty (legacy/default run)", async () => {
    const scrapeRuns = new FakeScrapeRunRepository();
    const transactions = new FakeTransactionRepository({ inserted: 1, skipped: 0 });
    const resolveScraper: ResolveScraper = (bankCode) => {
      // Absent bankCode should default to popular
      const code = bankCode && bankCode.trim() ? bankCode.trim() : "popular";
      return {
        collect: async () => ({
          status: "collected" as const,
          movements: popularMovements.map((m) => ({ ...m, bankId: code })),
        }),
      };
    };

    const processor = createIngestionProcessor({
      scrapeRuns,
      transactions,
      resolveScraper,
    });

    const result = await processor({
      data: { runId: "run-legacy", bankId: "", accountFingerprint: "acct-main" },
    });

    expect(result).toEqual({ status: "succeeded", inserted: 1, skipped: 0 });
    expect(transactions.received[0]?.bankId).toBe("popular");
  });

  it("throws when neither resolveScraper nor scraper is provided", () => {
    expect(() =>
      createIngestionProcessor({
        scrapeRuns: new FakeScrapeRunRepository(),
        transactions: new FakeTransactionRepository({ inserted: 0, skipped: 0 }),
      }),
    ).toThrow("createIngestionProcessor requires either resolveScraper or scraper");
  });

  it("falls back to the legacy scraper when resolveScraper is absent", async () => {
    const scrapeRuns = new FakeScrapeRunRepository();
    const transactions = new FakeTransactionRepository({ inserted: 1, skipped: 0 });
    const processor = createIngestionProcessor({
      scrapeRuns,
      transactions,
      scraper: { collect: async () => ({ status: "collected", movements: popularMovements }) },
    });

    const result = await processor({ data: jobData });

    expect(result).toEqual({ status: "succeeded", inserted: 1, skipped: 0 });
  });
});

describe("ingestion processor — scrape-time auto-login trigger", () => {
  it("runs the scrape-time auto-login trigger before collection when the job carries an expired event", async () => {
    const calls: string[] = [];
    const processor = createIngestionProcessor({
      scrapeRuns: new FakeScrapeRunRepository(),
      transactions: new FakeTransactionRepository({ inserted: 0, skipped: 0 }),
      scraper: {
        collect: async () => {
          calls.push("collect");
          return { status: "collected", movements: [] };
        },
      },
      runScrapeTimeAutoLogin: async (job) => {
        calls.push(`auto-login:${job.data.bankId}:${job.data.expiredEventId}`);
        return { status: "succeeded" };
      },
    });

    const result = await processor({
      data: { ...jobData, expiredEventId: "expired-1" },
    });

    expect(result).toEqual({ status: "succeeded", inserted: 0, skipped: 0 });
    expect(calls).toEqual(["auto-login:popular:expired-1", "collect"]);
  });

  it("does not run the scrape-time auto-login trigger without expiredEventId and still collects", async () => {
    const collect = vi.fn(async () => ({ status: "collected" as const, movements: [] }));
    const runScrapeTimeAutoLogin = vi.fn(async () => ({
      status: "needs_admin_action" as const,
      reason: "protected_flow" as const,
      safeSummary: "Bank auto-login requires admin action",
    }));
    const processor = createIngestionProcessor({
      scrapeRuns: new FakeScrapeRunRepository(),
      transactions: new FakeTransactionRepository({ inserted: 0, skipped: 0 }),
      scraper: { collect },
      runScrapeTimeAutoLogin,
    });

    const result = await processor({ data: jobData });

    expect(result).toEqual({ status: "succeeded", inserted: 0, skipped: 0 });
    expect(runScrapeTimeAutoLogin).not.toHaveBeenCalled();
    expect(collect).toHaveBeenCalledOnce();
  });

  it("collects normally when expiredEventId is present but no scrape-time auto-login runner is wired", async () => {
    const scrapeRuns = new FakeScrapeRunRepository();
    const collect = vi.fn(async () => ({ status: "collected" as const, movements: [] }));
    const processor = createIngestionProcessor({
      scrapeRuns,
      transactions: new FakeTransactionRepository({ inserted: 0, skipped: 0 }),
      scraper: { collect },
    });

    const result = await processor({ data: { ...jobData, expiredEventId: "expired-no-runner" } });

    expect(result).toEqual({ status: "succeeded", inserted: 0, skipped: 0 });
    expect(collect).toHaveBeenCalledOnce();
    expect(scrapeRuns.transitions).toEqual([
      { runId: "run-1", status: "running" },
      { runId: "run-1", status: "succeeded", insertedCount: 0, skippedCount: 0 },
    ]);
  });

  it("collects normally when the scrape-time auto-login runner returns null", async () => {
    const scrapeRuns = new FakeScrapeRunRepository();
    const collect = vi.fn(async () => ({ status: "collected" as const, movements: [] }));
    const runScrapeTimeAutoLogin = vi.fn(async () => null);
    const processor = createIngestionProcessor({
      scrapeRuns,
      transactions: new FakeTransactionRepository({ inserted: 0, skipped: 0 }),
      scraper: { collect },
      runScrapeTimeAutoLogin,
    });

    const result = await processor({ data: { ...jobData, expiredEventId: "expired-null-runner" } });

    expect(result).toEqual({ status: "succeeded", inserted: 0, skipped: 0 });
    expect(runScrapeTimeAutoLogin).toHaveBeenCalledOnce();
    expect(collect).toHaveBeenCalledOnce();
    expect(scrapeRuns.transitions).toEqual([
      { runId: "run-1", status: "running" },
      { runId: "run-1", status: "succeeded", insertedCount: 0, skippedCount: 0 },
    ]);
  });

  it("stops safely without collecting when auto-login requires admin action", async () => {
    const scrapeRuns = new FakeScrapeRunRepository();
    const transactions = new FakeTransactionRepository({ inserted: 0, skipped: 0 });
    const processor = createIngestionProcessor({
      scrapeRuns,
      transactions,
      scraper: {
        collect: async () => {
          throw new Error("collect must not run after auto-login admin action");
        },
      },
      runScrapeTimeAutoLogin: async () => ({
        status: "needs_admin_action",
        reason: "protected_flow",
        safeSummary: "Bank auto-login requires admin action",
      }),
    });

    const result = await processor({ data: { ...jobData, expiredEventId: "expired-2" } });

    expect(result).toEqual({ status: "needs_admin_action", inserted: 0, skipped: 0 });
    expect(scrapeRuns.transitions).toEqual([
      { runId: "run-1", status: "running" },
      {
        runId: "run-1",
        status: "needs_admin_action",
        safeErrorSummary: "Bank auto-login requires admin action",
      },
    ]);
    expect(transactions.received).toEqual([]);
  });

  it("persists throttled auto-login as deferred without collecting or alerting admins", async () => {
    const scrapeRuns = new FakeScrapeRunRepository();
    const transactions = new FakeTransactionRepository({ inserted: 0, skipped: 0 });
    const adminAlerts = new FakeAdminAlertSink();
    const auditSink = new InMemoryAuditSink();
    const collect = vi.fn(async () => {
      throw new Error("collect must not run after throttled auto-login");
    });
    const processor = createIngestionProcessor({
      scrapeRuns,
      transactions,
      adminAlerts,
      auditSink,
      scraper: { collect },
      runScrapeTimeAutoLogin: async () => ({
        status: "throttled",
        safeSummary: "Bank browser capacity is temporarily unavailable",
      }),
    });

    const result = await processor({ data: { ...jobData, expiredEventId: "expired-throttled" } });

    expect(result).toEqual({ status: "throttled", inserted: 0, skipped: 0 });
    expect(collect).not.toHaveBeenCalled();
    expect(scrapeRuns.transitions).toEqual([
      { runId: "run-1", status: "running" },
      {
        runId: "run-1",
        status: "throttled",
        safeErrorSummary: "Bank browser capacity is temporarily unavailable",
      },
    ]);
    expect(transactions.received).toEqual([]);
    expect(adminAlerts.events).toEqual([]);
    const events = await auditSink.list();
    expect(events.find((e) => e.action === "scrape_run.throttled")).toMatchObject({
      targetId: "run-1",
      metadata: {
        bankId: "popular",
        safeErrorSummary: "Bank browser capacity is temporarily unavailable",
      },
    });
    expect(events.find((e) => e.action === "bank_autologin.skipped")).toMatchObject({
      actorId: "system:auto-login",
      actorRole: null,
      target: "scrape_run",
      targetId: "run-1",
      metadata: { bankCode: "popular", reason: "throttled" },
    });
    const canonicalThrottledEvent = events.find((e) => e.action === "bank_autologin.skipped");
    expect(JSON.stringify(canonicalThrottledEvent?.metadata)).not.toContain("capacity");
    expect(events.find((e) => e.action === "scrape_run.needs_admin_action")).toBeUndefined();
  });

  it("maps thrown auto-login to safe admin action without leaking raw errors or collecting", async () => {
    const scrapeRuns = new FakeScrapeRunRepository();
    const transactions = new FakeTransactionRepository({ inserted: 0, skipped: 0 });
    const adminAlerts = new FakeAdminAlertSink();
    const auditSink = new InMemoryAuditSink();
    const collect = vi.fn(async () => {
      throw new Error("collect must not run after thrown auto-login");
    });
    const processor = createIngestionProcessor({
      scrapeRuns,
      transactions,
      adminAlerts,
      auditSink,
      scraper: { collect },
      runScrapeTimeAutoLogin: async () => {
        throw new Error("cdp unavailable token=secret password=abc cdp_url=internal-bank-host/session");
      },
    });

    const result = await processor({ data: { ...jobData, expiredEventId: "expired-throw" } });

    expect(result).toEqual({ status: "needs_admin_action", inserted: 0, skipped: 0 });
    expect(collect).not.toHaveBeenCalled();
    expect(scrapeRuns.transitions).toEqual([
      { runId: "run-1", status: "running" },
      {
        runId: "run-1",
        status: "needs_admin_action",
        safeErrorSummary: "Bank auto-login requires admin action",
      },
    ]);
    expect(transactions.received).toEqual([]);
    expect(adminAlerts.events).toEqual([
      {
        runId: "run-1",
        bankId: "popular",
        status: "needs_admin_action",
        safeErrorSummary: "Bank auto-login requires admin action",
      },
    ]);
    const events = await auditSink.list();
    const needsAdminEvent = events.find((e) => e.action === "scrape_run.needs_admin_action");
    expect(needsAdminEvent).toMatchObject({
      targetId: "run-1",
      metadata: { bankId: "popular", safeErrorSummary: "Bank auto-login requires admin action" },
    });
    const serializedTerminalState = JSON.stringify({
      transitions: scrapeRuns.transitions,
      alerts: adminAlerts.events,
      auditMetadata: needsAdminEvent?.metadata,
    });
    expect(serializedTerminalState).not.toContain("secret");
    expect(serializedTerminalState).not.toContain("abc");
    expect(serializedTerminalState).not.toContain("internal-bank-host");
  });

  it("continues to manual scrape path when auto-login is manual_required and returns collection outcome", async () => {
    const calls: string[] = [];
    const processor = createIngestionProcessor({
      scrapeRuns: new FakeScrapeRunRepository(),
      transactions: new FakeTransactionRepository({ inserted: 0, skipped: 0 }),
      scraper: {
        collect: async () => {
          calls.push("collect");
          return { status: "needs_admin_action", movements: [], safeErrorSummary: "Manual login required" };
        },
      },
      runScrapeTimeAutoLogin: async () => {
        calls.push("auto-login");
        return { status: "manual_required", reason: "lock_busy", safeSummary: "Manual scrape required before retrying bank auto-login" };
      },
    });

    const result = await processor({ data: { ...jobData, expiredEventId: "expired-3" } });

    expect(result).toEqual({ status: "needs_admin_action", inserted: 0, skipped: 0 });
    expect(calls).toEqual(["auto-login", "collect"]);
  });
});

class FakeScrapeRunRepository {
  readonly transitions: Array<{
    runId: string;
    status: ScrapeRunStatus;
    insertedCount?: number;
    skippedCount?: number;
    safeErrorSummary?: string;
  }> = [];

  async markRunning(runId: string): Promise<void> {
    this.transitions.push({ runId, status: "running" });
  }

  async markSucceeded(runId: string, counts: { insertedCount: number; skippedCount: number }): Promise<void> {
    this.transitions.push({ runId, status: "succeeded", ...counts });
  }

  async markNeedsAdminAction(runId: string, safeErrorSummary: string): Promise<void> {
    this.transitions.push({ runId, status: "needs_admin_action", safeErrorSummary });
  }

  async markThrottled(runId: string, safeErrorSummary: string): Promise<void> {
    this.transitions.push({ runId, status: "throttled", safeErrorSummary });
  }

  async markFailed(runId: string, safeErrorSummary: string): Promise<void> {
    this.transitions.push({ runId, status: "failed", safeErrorSummary });
  }
}

class FakeTransactionRepository {
  readonly received: Awaited<ReturnType<typeof import("../../modules/transactions").normalizeBankMovement>>[] = [];

  constructor(private readonly result: { inserted: number; skipped: number }) {}

  async upsertMany(records: typeof this.received): Promise<{ inserted: number; skipped: number }> {
    this.received.push(...records);
    return this.result;
  }
}

class FakeQueue {
  readonly addCalls: Array<{ name: string; data: IngestionJobData; options: unknown }> = [];

  async add(name: string, data: IngestionJobData, options: unknown): Promise<void> {
    this.addCalls.push({ name, data, options });
  }
}

class FakeAdminAlertSink {
  readonly events: Array<{
    runId: string;
    bankId: string;
    status: "failed" | "needs_admin_action";
    safeErrorSummary: string;
  }> = [];

  async notifyIngestionAttention(event: {
    runId: string;
    bankId: string;
    status: "failed" | "needs_admin_action";
    safeErrorSummary: string;
  }): Promise<void> {
    this.events.push(event);
  }

  async notifySessionAttention(): Promise<void> {
    // no-op in tests that don't exercise session alerts
  }
}
