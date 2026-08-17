import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import type { AuthenticatedIngestionDeliveryDependencies } from "./authenticated-ingestion-delivery";
import { CollectionIngestionPersistenceError, createCollectionIngestionProcessor, type CollectionIngestionProcessorDependencies } from "./collection-ingestion-processor";
import type { IngestionResult } from "./queues";

const job = { data: { runId: "run-1", bankId: "popular", accountFingerprint: "account-secret" } };
const movement = { bankId: "popular", accountFingerprint: "account-secret", postedAt: "2026-01-02", amount: "10.00", currency: "DOP", direction: "debit" as const, reference: "raw-reference" };

function createDependencies(overrides: Partial<CollectionIngestionProcessorDependencies> = {}) {
  const calls: string[] = [];
  const dependencies: CollectionIngestionProcessorDependencies = {
    scrapeRuns: {
      markRunning: vi.fn(async () => { calls.push("running"); }),
      markSucceeded: vi.fn(async () => { calls.push("succeeded"); }),
      markNeedsAdminAction: vi.fn(async () => { calls.push("admin"); }),
      markThrottled: vi.fn(),
      markFailed: vi.fn(async () => { calls.push("failed"); }),
    },
    transactions: { upsertMany: vi.fn(async () => { calls.push("upsert"); return { inserted: 1, skipped: 2 }; }) },
    resolveScraper: vi.fn(() => ({ collect: vi.fn(async () => ({ status: "collected" as const, movements: [movement] })) })),
    adminAlerts: { notifyIngestionAttention: vi.fn(async () => { calls.push("alert"); }), notifySessionAttention: vi.fn() },
    auditSink: { record: vi.fn(async (event) => { calls.push(event.action); }) },
    now: () => new Date("2026-01-03T00:00:00.000Z"),
    ...overrides,
  };
  return { dependencies, calls };
}

describe("createCollectionIngestionProcessor", () => {
  it("collects once, persists normalized records, and completes a successful run", async () => {
    const { dependencies, calls } = createDependencies();
    const result = await createCollectionIngestionProcessor(dependencies)(job);
    expect(result).toEqual({ status: "succeeded", inserted: 1, skipped: 2 });
    expect(calls).toEqual(["running", "scrape_run.started", "upsert", "succeeded", "scrape_run.succeeded"]);
    expect(dependencies.resolveScraper).toHaveBeenCalledWith("popular");
    expect(dependencies.transactions.upsertMany).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ scrapeRunId: "run-1", sourceHash: expect.any(String) })]));
  });

  it("succeeds with an empty collection without an upsert", async () => {
    const { dependencies } = createDependencies({ resolveScraper: vi.fn(() => ({ collect: vi.fn(async () => ({ status: "collected" as const, movements: [] })) })) });
    await expect(createCollectionIngestionProcessor(dependencies)(job)).resolves.toEqual({ status: "succeeded", inserted: 0, skipped: 0 });
    expect(dependencies.transactions.upsertMany).not.toHaveBeenCalled();
  });

  it("preserves repository duplicate counts after normalization", async () => {
    const { dependencies } = createDependencies({ transactions: { upsertMany: vi.fn(async () => ({ inserted: 0, skipped: 1 })) } });
    await expect(createCollectionIngestionProcessor(dependencies)(job)).resolves.toEqual({ status: "succeeded", inserted: 0, skipped: 1 });
  });

  it("makes session expiry terminal without retrying, recovering, or persisting", async () => {
    const { dependencies, calls } = createDependencies({ resolveScraper: vi.fn(() => ({ collect: vi.fn(async () => ({ status: "needs_admin_action" as const, cause: "session_expired" as const, movements: [] })) })) });
    await expect(createCollectionIngestionProcessor(dependencies)(job)).resolves.toEqual({ status: "needs_admin_action", inserted: 0, skipped: 0 });
    expect(dependencies.transactions.upsertMany).not.toHaveBeenCalled();
    expect(calls).toContain("admin");
    expect(calls).toContain("scrape_run.needs_admin_action");
    expect(dependencies.scrapeRuns.markNeedsAdminAction).toHaveBeenCalledWith("run-1", "Bank session requires admin action", expect.any(Date));
  });

  it("fails closed for unknown banks without collecting", async () => {
    const { dependencies } = createDependencies({ resolveScraper: vi.fn(() => { throw new Error("unknown bank"); }) });
    await expect(createCollectionIngestionProcessor(dependencies)(job)).resolves.toEqual({ status: "failed", inserted: 0, skipped: 0 });
    expect(dependencies.transactions.upsertMany).not.toHaveBeenCalled();
    expect(dependencies.scrapeRuns.markFailed).toHaveBeenCalledWith("run-1", "Ingestion collection failed", expect.any(Date));
  });

  it("rejects safely when it cannot mark a run running", async () => {
    const fixture = createDependencies();
    fixture.dependencies.scrapeRuns.markRunning = vi.fn(async () => { throw new Error("secret-sentinel"); });
    const { dependencies } = fixture;
    let error: unknown;
    try { await createCollectionIngestionProcessor(dependencies)(job); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(CollectionIngestionPersistenceError);
    expect(String(error)).not.toContain("secret-sentinel");
    expect(dependencies.resolveScraper).not.toHaveBeenCalled();
    expect(dependencies.scrapeRuns.markFailed).not.toHaveBeenCalled();
  });

  it("compensates a failed succeeded transition exactly once", async () => {
    const fixture = createDependencies();
    fixture.dependencies.scrapeRuns.markSucceeded = vi.fn(async () => { fixture.calls.push("succeeded"); throw new Error("secret-sentinel"); });
    const { dependencies, calls } = fixture;
    await expect(createCollectionIngestionProcessor(dependencies)(job)).resolves.toEqual({ status: "failed", inserted: 0, skipped: 0 });
    expect(calls).toEqual(["running", "scrape_run.started", "upsert", "succeeded", "failed", "alert", "scrape_run.failed"]);
    expect(dependencies.scrapeRuns.markFailed).toHaveBeenCalledTimes(1);
  });

  it("rejects safely when succeeded and compensating terminal transitions both fail", async () => {
    const fixture = createDependencies();
    fixture.dependencies.scrapeRuns.markSucceeded = vi.fn(async () => { throw new Error("secret-sentinel"); });
    fixture.dependencies.scrapeRuns.markFailed = vi.fn(async () => { throw new Error("secret-sentinel"); });
    const { dependencies } = fixture;
    await expect(createCollectionIngestionProcessor(dependencies)(job)).rejects.toBeInstanceOf(CollectionIngestionPersistenceError);
    expect(dependencies.scrapeRuns.markFailed).toHaveBeenCalledTimes(1);
  });

  it("preserves a trusted non-expiry admin summary in terminal state, alert, and audit", async () => {
    const { dependencies } = createDependencies({ resolveScraper: vi.fn(() => ({ collect: vi.fn(async () => ({ status: "needs_admin_action" as const, movements: [], safeErrorSummary: "Portal requires a human review" })) })) });
    await expect(createCollectionIngestionProcessor(dependencies)(job)).resolves.toEqual({ status: "needs_admin_action", inserted: 0, skipped: 0 });
    expect(dependencies.scrapeRuns.markNeedsAdminAction).toHaveBeenCalledWith("run-1", "Portal requires a human review", expect.any(Date));
    expect(dependencies.adminAlerts?.notifyIngestionAttention).toHaveBeenCalledWith(expect.objectContaining({ safeErrorSummary: "Portal requires a human review" }));
    expect(dependencies.auditSink?.record).toHaveBeenLastCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ safeErrorSummary: "Portal requires a human review" }) }));
  });

  it.each([
    ["collector throw", { collect: vi.fn(async () => { throw new Error("secret-sentinel"); }) }],
    ["malformed collector result", { collect: vi.fn(async () => ({ status: "collected", movements: "secret-sentinel" } as unknown as never)) }],
  ])("fails safely for %s without leaking diagnostics", async (_name, scraper) => {
    const { dependencies } = createDependencies({ resolveScraper: vi.fn(() => scraper) });
    await expect(createCollectionIngestionProcessor(dependencies)(job)).resolves.toEqual({ status: "failed", inserted: 0, skipped: 0 });
    expect(JSON.stringify([vi.mocked(dependencies.scrapeRuns.markFailed).mock.calls, vi.mocked(dependencies.adminAlerts!.notifyIngestionAttention).mock.calls, vi.mocked(dependencies.auditSink!.record).mock.calls])).not.toContain("secret-sentinel");
  });

  it("fails closed for hostile job descriptors and persistence or terminal failures", async () => {
    const hostile = { data: {} };
    Object.defineProperty(hostile.data, "runId", { enumerable: true, get: () => { throw new Error("secret-sentinel"); } });
    const malformed = createDependencies();
    await expect(createCollectionIngestionProcessor(malformed.dependencies)(hostile)).resolves.toEqual({ status: "failed", inserted: 0, skipped: 0 });
    const persistence = createDependencies({ transactions: { upsertMany: vi.fn(async () => { throw new Error("secret-sentinel"); }) } });
    await expect(createCollectionIngestionProcessor(persistence.dependencies)(job)).resolves.toEqual({ status: "failed", inserted: 0, skipped: 0 });
    expect(persistence.dependencies.scrapeRuns.markFailed).toHaveBeenCalledTimes(1);
    const terminal = createDependencies({ scrapeRuns: { ...persistence.dependencies.scrapeRuns, markSucceeded: vi.fn(async () => { throw new Error("secret-sentinel"); }) } });
    await expect(createCollectionIngestionProcessor(terminal.dependencies)(job)).resolves.toEqual({ status: "failed", inserted: 0, skipped: 0 });
  });

  it("rejects safely when upsert and its failed transition both reject", async () => {
    const fixture = createDependencies({ transactions: { upsertMany: vi.fn(async () => { throw new Error("secret-sentinel"); }) } });
    fixture.dependencies.scrapeRuns.markFailed = vi.fn(async () => { throw new Error("secret-sentinel"); });
    await expect(createCollectionIngestionProcessor(fixture.dependencies)(job)).rejects.toBeInstanceOf(CollectionIngestionPersistenceError);
    expect(fixture.dependencies.scrapeRuns.markFailed).toHaveBeenCalledTimes(1);
  });

  it("does not let audit or alert delivery alter a completed result", async () => {
    const { dependencies } = createDependencies({ resolveScraper: vi.fn(() => ({ collect: vi.fn(async () => ({ status: "needs_admin_action" as const, movements: [] })) })), adminAlerts: { notifyIngestionAttention: vi.fn(async () => { throw new Error("secret-sentinel"); }), notifySessionAttention: vi.fn() }, auditSink: { record: vi.fn(async () => { throw new Error("secret-sentinel"); }) } });
    await expect(createCollectionIngestionProcessor(dependencies)(job)).resolves.toEqual({ status: "needs_admin_action", inserted: 0, skipped: 0 });
  });

  it("is compatible as authenticated delivery downstream and contains no recovery or runtime secrets", () => {
    const processAuthenticated: AuthenticatedIngestionDeliveryDependencies<IngestionResult>["downstream"] = createCollectionIngestionProcessor(createDependencies().dependencies);
    expect(processAuthenticated).toBeTypeOf("function");
    const source = readFileSync(new URL("./collection-ingestion-processor.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/expiryEpisodes|runScrapeTimeAutoLogin|recoverExpiredSession|credential|browser|process\.env|bullmq/i);
  });
});
