import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { encryptCredentialField } from "../modules/bank-credentials/crypto";
import {
  AuthenticatedIngestionRetryError,
  AuthenticatedIngestionTerminalError,
} from "./authenticated-ingestion-delivery";
import { createAuthenticatedIngestionProcessor, createAuthenticatedTerminalCompleter } from "./authenticated-ingestion-composition";
import type { FencedScrapeTimeAutoLoginRunnerDependencies } from "./scraper/scrape-time-auto-login-authentication-execution";
import type { BankAutoLoginPage } from "./scraper/auto-login";

const payload = (attemptId = "attempt-1") => ({ data: { runId: "run-1", bankId: "popular", accountFingerprint: "fingerprint-1", authentication: { version: 1, attemptId } } });
const env = { RD_SYNC_AUTHENTICATION_LEASE_MS: "60000", RD_SYNC_AUTHENTICATION_HEARTBEAT_MS: "15000" };

function fixture(overrides: Record<string, unknown> = {}) {
  let authenticated = false;
  let ownerToken = "";
  let phase: "no_credential_interaction" | "credentials_may_have_reached_portal" | "submit_may_have_been_dispatched" = "no_credential_interaction";
  const identity = { bankCode: "popular", runId: "run-1", attemptId: "attempt-1" };
  const now = new Date("2026-08-21T00:00:00.000Z");
  const record = (owner = false) => authenticated
    ? { identity, status: "authenticated" as const, interactionPhase: phase, failureClass: null, operatorReason: null, retryCount: 0, ownerToken: null, generation: 1n, leaseExpiresAt: null, terminalAt: now, createdAt: now, updatedAt: now }
    : { identity, status: "active" as const, interactionPhase: phase, failureClass: null, operatorReason: null, retryCount: 0, ownerToken: owner ? ownerToken : null, generation: 0n, leaseExpiresAt: owner ? now : null, terminalAt: null, createdAt: now, updatedAt: now };
  const page = { currentUrl: async () => "https://bank/login", hasVisibleSelector: async () => false, fill: vi.fn(), click: vi.fn() };
  const scheduler = { schedule: vi.fn(() => ({})), cancel: vi.fn() };
  const key = Buffer.alloc(32, 7);
  const runnerDependencies: FencedScrapeTimeAutoLoginRunnerDependencies = {
    adapterRegistry: { get: vi.fn(() => ({ bankCode: "popular", createAutoLoginStrategy: () => ({ bankCode: "popular", autoLogin: async ({ page: guarded }: { page: BankAutoLoginPage }) => { await guarded.fill("user", "u"); await guarded.click("submit"); return { status: "succeeded" as const }; } }) })) },
    autoLoginConfigs: { getByBankCode: vi.fn().mockResolvedValue({ autoLoginEnabled: true, breakerState: "closed" }) },
    credentials: { findByBankCode: vi.fn().mockResolvedValue({ bankCode: "popular", isActive: true, keyVersion: 1, encryptedUsernameEnvelope: JSON.stringify(encryptCredentialField("u", () => key)), encryptedPasswordEnvelope: JSON.stringify(encryptCredentialField("p", () => key)) }) },
    keyResolver: () => key, lock: { acquire: vi.fn().mockResolvedValue({ leaseToken: "lease", fencingToken: 1, expiresAt: 1 }), release: vi.fn().mockResolvedValue(true) }, cdpUrlForBankCode: () => "http://127.0.0.1:9222", ensureBrowser: vi.fn().mockResolvedValue({ status: "ready", page, close: vi.fn() }),
  };
  const scrapeRuns = { markRunning: vi.fn(async () => {}), markSucceeded: vi.fn(async () => {}), markNeedsAdminAction: vi.fn(async () => {}), markThrottled: vi.fn(), markFailed: vi.fn(async () => {}) };
  const auditSink = { record: vi.fn(async () => {}) };
  const adminAlerts = { notifyIngestionAttention: vi.fn(async () => {}), notifySessionAttention: vi.fn(async () => {}) };
  const collect = vi.fn(async () => ({ status: "collected" as const, movements: [] }));
  const createOwnerToken = vi.fn().mockReturnValueOnce("owner-1").mockReturnValueOnce("owner-2");
  const processor = createAuthenticatedIngestionProcessor({
    env, popularSessionChecker: { check: async () => ({ status: authenticated ? "active" : "expired", checkedAt: "2026-08-21T00:00:00.000Z", safeSummary: "safe" }) },
    attempts: { findExact: async () => authenticated ? { status: "found", record: record() } : { status: "missing" }, getOrCreate: async () => ({ status: "created", record: record() }), acquireLease: async (input: { ownerToken: string }) => { ownerToken = input.ownerToken; return { status: "lease_acquired", owner: { identity, ownerToken, generation: 0n }, record: record(true) }; }, reconcileExpiredLease: async () => ({ status: "missing" }), renewLease: async () => ({ status: "lease_renewed", record: record(true) }), beginCredentialInteraction: async () => { phase = "credentials_may_have_reached_portal"; return { status: "interaction_started", record: record(true) }; }, recordSubmitBarrier: async () => { phase = "submit_may_have_been_dispatched"; return { status: "recorded", record: record(true) }; }, claimRetry: async () => ({ status: "retry_claimed", retryCount: 1 as const, record: record() }), completeAuthenticated: async () => { authenticated = true; return { status: "authenticated", record: record() }; }, completeFailed: async () => ({ status: "failed", record: record() }) } as never,
    runnerDependencies, heartbeat: scheduler, scrapeRuns, auditSink, adminAlerts, transactions: { upsertMany: vi.fn(async () => ({ inserted: 0, skipped: 0 })) }, resolveScraper: vi.fn(() => ({ collect })), createOwnerToken, now: () => now, ...overrides,
  });
  return { processor, page, scheduler, runnerDependencies, scrapeRuns, auditSink, adminAlerts, collect, createOwnerToken };
}

describe("createAuthenticatedIngestionProcessor", () => {
  it.each([
    ["failed", "invalid_authenticated_ingestion_delivery", "scrape_run.failed", "Authenticated ingestion delivery failed"],
    ["needs_admin_action", "legacy_authenticated_ingestion_delivery", "scrape_run.needs_admin_action", "Authenticated ingestion requires admin action"],
    ["needs_admin_action", "temporary_authentication_problem", "scrape_run.needs_admin_action", "Authenticated ingestion requires admin action"],
    ["needs_admin_action", "protected_authentication_step_detected", "scrape_run.needs_admin_action", "Authenticated ingestion requires admin action"],
    ["needs_admin_action", "bank_login_configuration_requires_review", "scrape_run.needs_admin_action", "Authenticated ingestion requires admin action"],
    ["needs_admin_action", "authentication_attempt_requires_review", "scrape_run.needs_admin_action", "Authenticated ingestion requires admin action"],
    ["needs_admin_action", "identity_conflict", "scrape_run.needs_admin_action", "Authenticated ingestion requires admin action"],
    ["needs_admin_action", "restoration_state_conflict", "scrape_run.needs_admin_action", "Authenticated ingestion requires admin action"],
    ["failed", "invalid_authenticated_ingestion_precondition", "scrape_run.failed", "Authenticated ingestion delivery failed"],
    ["needs_admin_action", "authentication_precondition_requires_review", "scrape_run.needs_admin_action", "Authenticated ingestion requires admin action"],
  ] as const)("records and alerts the closed %s/%s terminal safely", async (status, reason, action, summary) => {
    const scrapeRuns = { markFailed: vi.fn(async () => {}), markNeedsAdminAction: vi.fn(async () => {}) };
    const auditSink = { record: vi.fn<(event: { id: string }) => Promise<void>>(async () => {}) };
    const adminAlerts = { notifyIngestionAttention: vi.fn(async () => {}) };
    const complete = createAuthenticatedTerminalCompleter({ scrapeRuns, auditSink, adminAlerts, now: () => new Date("2026-08-21T00:00:00.000Z") });

    await expect(complete({ runId: "run-1", bankId: "popular", status, reason })).resolves.toEqual({ status, inserted: 0, skipped: 0 });
    expect(scrapeRuns[status === "failed" ? "markFailed" : "markNeedsAdminAction"]).toHaveBeenCalledExactlyOnceWith("run-1", summary, new Date("2026-08-21T00:00:00.000Z"));
    expect(auditSink.record).toHaveBeenCalledOnce();
    expect(auditSink.record).toHaveBeenCalledWith(expect.objectContaining({ id: expect.stringMatching(/^authenticated-terminal:v1:/), actorId: "system:ingestion-worker", actorRole: null, action, target: "scrape_run", targetId: "run-1", metadata: { stage: "precollection_authentication", reason, status, bankId: "popular" } }));
    expect((auditSink.record.mock.calls[0]?.[0] as { id: string }).id).not.toMatch(/run-1|popular|invalid_authenticated_ingestion_delivery/);
    expect(adminAlerts.notifyIngestionAttention).toHaveBeenCalledExactlyOnceWith({ runId: "run-1", bankId: "popular", status, safeErrorSummary: summary });
  });

  it("omits bank metadata and skips alerts when no descriptor-validated bank is available", async () => {
    const scrapeRuns = { markFailed: vi.fn(async () => {}), markNeedsAdminAction: vi.fn(async () => {}) };
    const auditSink = { record: vi.fn(async () => {}) };
    const adminAlerts = { notifyIngestionAttention: vi.fn(async () => {}) };
    const complete = createAuthenticatedTerminalCompleter({ scrapeRuns, auditSink, adminAlerts });

    await complete({ runId: "run-1", status: "failed", reason: "invalid_authenticated_ingestion_delivery" });
    expect(auditSink.record).toHaveBeenCalledWith(expect.objectContaining({ metadata: { stage: "precollection_authentication", reason: "invalid_authenticated_ingestion_delivery", status: "failed" } }));
    expect(adminAlerts.notifyIngestionAttention).not.toHaveBeenCalled();
    expect(JSON.stringify({ audit: auditSink.record.mock.calls, alerts: adminAlerts.notifyIngestionAttention.mock.calls })).not.toContain("unknown");
  });

  it("keeps telemetry non-blocking and independent after exactly-once persistence", async () => {
    const sentinel = "raw-telemetry-sentinel";
    const scrapeRuns = { markFailed: vi.fn(async () => {}), markNeedsAdminAction: vi.fn(async () => {}) };
    const auditSink = { record: vi.fn(async () => { throw new Error(sentinel); }) };
    const adminAlerts = { notifyIngestionAttention: vi.fn(async () => { throw new Error(sentinel); }) };
    const complete = createAuthenticatedTerminalCompleter({ scrapeRuns, auditSink, adminAlerts });

    await expect(complete({ runId: "run-1", bankId: "popular", status: "failed", reason: "invalid_authenticated_ingestion_delivery" })).resolves.toEqual({ status: "failed", inserted: 0, skipped: 0 });
    expect(scrapeRuns.markFailed).toHaveBeenCalledOnce(); expect(auditSink.record).toHaveBeenCalledOnce(); expect(adminAlerts.notifyIngestionAttention).toHaveBeenCalledOnce();
    expect(JSON.stringify({ result: await complete({ runId: "run-2", bankId: "popular", status: "failed", reason: "invalid_authenticated_ingestion_delivery" }), calls: [auditSink.record.mock.calls, adminAlerts.notifyIngestionAttention.mock.calls] })).not.toContain(sentinel);
  });

  it.each(["audit", "alert"] as const)("returns the persisted terminal result when only %s delivery fails", async (failing) => {
    const auditSink = { record: vi.fn(async () => { if (failing === "audit") throw new Error("raw-audit-sentinel"); }) };
    const adminAlerts = { notifyIngestionAttention: vi.fn(async () => { if (failing === "alert") throw new Error("raw-alert-sentinel"); }) };
    const complete = createAuthenticatedTerminalCompleter({ scrapeRuns: { markFailed: vi.fn(async () => {}), markNeedsAdminAction: vi.fn(async () => {}) }, auditSink, adminAlerts });

    await expect(complete({ runId: "run-1", bankId: "popular", status: "failed", reason: "invalid_authenticated_ingestion_delivery" })).resolves.toEqual({ status: "failed", inserted: 0, skipped: 0 });
    expect(auditSink.record).toHaveBeenCalledOnce(); expect(adminAlerts.notifyIngestionAttention).toHaveBeenCalledOnce();
  });

  it("does not emit telemetry when terminal persistence fails and redelivery repeats persistence and alert delivery", async () => {
    let persistenceFails = true;
    const scrapeRuns = { markFailed: vi.fn(async () => { if (persistenceFails) throw new Error("raw-persistence-sentinel"); }), markNeedsAdminAction: vi.fn(async () => {}) };
    const auditSink = { record: vi.fn<(event: { id: string }) => Promise<void>>(async () => {}) };
    const adminAlerts = { notifyIngestionAttention: vi.fn(async () => {}) };
    const complete = createAuthenticatedTerminalCompleter({ scrapeRuns, auditSink, adminAlerts });
    const outcome = { runId: "run-1", bankId: "popular", status: "failed" as const, reason: "invalid_authenticated_ingestion_delivery" as const };

    await expect(complete(outcome)).rejects.toEqual(new AuthenticatedIngestionTerminalError());
    expect(auditSink.record).not.toHaveBeenCalled(); expect(adminAlerts.notifyIngestionAttention).not.toHaveBeenCalled();
    persistenceFails = false; await complete(outcome); await complete(outcome);
    expect(scrapeRuns.markFailed).toHaveBeenCalledTimes(3);
    expect(auditSink.record.mock.calls.map(([event]) => (event as { id: string }).id)).toEqual([expect.stringMatching(/^authenticated-terminal:v1:/), expect.stringMatching(/^authenticated-terminal:v1:/)]);
    expect((auditSink.record.mock.calls[0]?.[0] as { id: string }).id).toBe((auditSink.record.mock.calls[1]?.[0] as { id: string }).id);
    expect(adminAlerts.notifyIngestionAttention).toHaveBeenCalledTimes(2);
  });

  it("uses collision-resistant opaque audit IDs for every terminal identity tuple", async () => {
    const auditSink = { record: vi.fn<(event: { id: string }) => Promise<void>>(async () => {}) };
    const complete = createAuthenticatedTerminalCompleter({ scrapeRuns: { markFailed: vi.fn(async () => {}), markNeedsAdminAction: vi.fn(async () => {}) }, auditSink });
    const base = { runId: "run\ud800", bankId: "bank\ud800", status: "failed" as const, reason: "invalid_authenticated_ingestion_delivery" as const };

    await complete(base); await complete(base); await complete({ ...base, bankId: "bank\ufffd" }); await complete({ ...base, runId: "run\ufffd" }); await complete({ ...base, status: "needs_admin_action", reason: "authentication_precondition_requires_review" });
    const ids = auditSink.record.mock.calls.map(([event]) => (event as { id: string }).id);
    expect(ids[0]).toBe(ids[1]); expect(new Set(ids.slice(0, 1).concat(ids.slice(2))).size).toBe(4);
    expect(ids.join(" ")).not.toMatch(/bank|run|\ud800|\ufffd/);
  });

  it("composes the actual authenticated path once and reuses durable authentication on duplicate delivery", async () => {
    const f = fixture();
    const first = await f.processor(payload()); const second = await f.processor(payload());
    expect([first, second]).toEqual([{ status: "succeeded", inserted: 0, skipped: 0 }, { status: "succeeded", inserted: 0, skipped: 0 }]);
    expect(f.page.fill).toHaveBeenCalledOnce(); expect(f.page.click).toHaveBeenCalledOnce(); expect(f.scheduler.schedule).toHaveBeenCalledOnce(); expect(f.scheduler.cancel).toHaveBeenCalledOnce(); expect(f.collect).toHaveBeenCalledTimes(2);
    expect(f.createOwnerToken).toHaveBeenCalledTimes(2); expect(JSON.stringify({ first, second, calls: f.collect.mock.calls })).not.toMatch(/owner-|attempt-|fingerprint|credential|http/);
  });

  it("uses an already-authenticated probe without touching credential mutation dependencies", async () => {
    const f = fixture({ popularSessionChecker: { check: async () => ({ status: "active", checkedAt: "2026-08-21T00:00:00.000Z", safeSummary: "safe" }) } });
    await expect(f.processor(payload())).resolves.toEqual({ status: "succeeded", inserted: 0, skipped: 0 });
    expect(f.runnerDependencies.credentials.findByBankCode).not.toHaveBeenCalled(); expect(f.page.fill).not.toHaveBeenCalled(); expect(f.collect).toHaveBeenCalledOnce();
  });

  it.each([
    ["legacy", { data: { runId: "run-1", bankId: "popular", accountFingerprint: "fingerprint-1" } }, "markNeedsAdminAction"],
    ["invalid", { data: { runId: "run-1", bankId: "popular" } }, "markFailed"],
  ])("maps %s delivery terminally once without authentication or collection", async (_name, job, method) => {
    const f = fixture();
    await f.processor(job);
    expect(f.scrapeRuns[method as "markFailed" | "markNeedsAdminAction"]).toHaveBeenCalledOnce(); expect(f.runnerDependencies.credentials.findByBankCode).not.toHaveBeenCalled(); expect(f.collect).not.toHaveBeenCalled();
  });

  it("maps terminal persistence failures to the fixed error without a cause", async () => {
    const f = fixture({ scrapeRuns: { markRunning: vi.fn(), markSucceeded: vi.fn(), markNeedsAdminAction: vi.fn(async () => { throw new Error("raw terminal sentinel"); }), markThrottled: vi.fn(), markFailed: vi.fn() } });
    await expect(f.processor({ data: { runId: "run-1", bankId: "popular", accountFingerprint: "fingerprint-1" } })).rejects.toEqual(new AuthenticatedIngestionTerminalError());
  });

  it("propagates cancellation as typed retry before mutation or collection", async () => {
    const f = fixture(); const controller = new AbortController(); controller.abort();
    await expect(f.processor({ ...payload(), signal: controller.signal, deliveryAttempt: { attemptsMade: 0, maxAttempts: 2 } })).rejects.toEqual(new AuthenticatedIngestionRetryError("cancelled"));
    expect(f.runnerDependencies.credentials.findByBankCode).not.toHaveBeenCalled(); expect(f.collect).not.toHaveBeenCalled(); expect(f.scrapeRuns.markFailed).not.toHaveBeenCalled(); expect(f.scrapeRuns.markNeedsAdminAction).not.toHaveBeenCalled(); expect(f.auditSink.record).not.toHaveBeenCalled(); expect(f.adminAlerts.notifyIngestionAttention).not.toHaveBeenCalled();
  });

  it("rethrows the retry delivery error before the final attempt", async () => {
    const f = fixture({ attempts: { findExact: async () => ({ status: "unexpected" }) } as never });
    await expect(f.processor({ ...payload(), deliveryAttempt: { attemptsMade: 0, maxAttempts: 2 } })).rejects.toEqual(new AuthenticatedIngestionRetryError("retry_delivery"));
    expect(f.scrapeRuns.markFailed).not.toHaveBeenCalled(); expect(f.scrapeRuns.markNeedsAdminAction).not.toHaveBeenCalled(); expect(f.collect).not.toHaveBeenCalled();
  });

  it("terminalizes an exhausted retry once with finite telemetry", async () => {
    const f = fixture({ attempts: { findExact: async () => ({ status: "unexpected" }) } as never });
    await expect(f.processor({ ...payload(), deliveryAttempt: { attemptsMade: 1, maxAttempts: 2 } })).resolves.toEqual({ status: "needs_admin_action", inserted: 0, skipped: 0 });
    expect(f.scrapeRuns.markNeedsAdminAction).toHaveBeenCalledOnce(); expect(f.collect).not.toHaveBeenCalled();
    expect(f.auditSink.record).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ reason: "authenticated_ingestion_retry_exhausted" }) }));
  });

  it("maps exhausted retry terminal persistence failure to the fixed terminal error", async () => {
    const f = fixture({ attempts: { findExact: async () => ({ status: "unexpected" }) } as never, scrapeRuns: { markRunning: vi.fn(), markSucceeded: vi.fn(), markNeedsAdminAction: vi.fn(async () => { throw new Error("raw terminal sentinel"); }), markThrottled: vi.fn(), markFailed: vi.fn() } });
    await expect(f.processor({ ...payload(), deliveryAttempt: { attemptsMade: 1, maxAttempts: 2 } })).rejects.toEqual(new AuthenticatedIngestionTerminalError());
    expect(f.collect).not.toHaveBeenCalled();
  });

  it("does not let an aborted delivery signal affect the next fresh delivery", async () => {
    const f = fixture(); const controller = new AbortController(); controller.abort();
    await expect(f.processor({ ...payload(), signal: controller.signal, deliveryAttempt: { attemptsMade: 0, maxAttempts: 2 } })).rejects.toEqual(new AuthenticatedIngestionRetryError("cancelled"));
    await expect(f.processor(payload())).resolves.toEqual({ status: "succeeded", inserted: 0, skipped: 0 });
    expect(f.page.fill).toHaveBeenCalledOnce(); expect(f.collect).toHaveBeenCalledOnce();
  });

  it("does not authenticate or collect when cancellation arrives during a session check", async () => {
    let resolve!: (result: unknown) => void;
    const pending = new Promise<unknown>((done) => { resolve = done; });
    const f = fixture({ popularSessionChecker: { check: async () => pending } }); const controller = new AbortController();
    const result = f.processor({ ...payload(), signal: controller.signal, deliveryAttempt: { attemptsMade: 0, maxAttempts: 2 } }); controller.abort(); resolve({ status: "active", checkedAt: "2026-08-21T00:00:00.000Z", safeSummary: "safe" });
    await expect(result).rejects.toBeInstanceOf(AuthenticatedIngestionRetryError);
    expect(f.runnerDependencies.credentials.findByBankCode).not.toHaveBeenCalled(); expect(f.collect).not.toHaveBeenCalled();
  });

  it("makes a collection session expiry terminal once without recovery or recollection", async () => {
    const sessionExpiredCollect = vi.fn(async () => ({ status: "needs_admin_action" as const, cause: "session_expired" as const, movements: [] }));
    const f = fixture({ resolveScraper: vi.fn(() => ({ collect: sessionExpiredCollect })) });
    await expect(f.processor(payload())).resolves.toEqual({ status: "needs_admin_action", inserted: 0, skipped: 0 });
    expect(f.scrapeRuns.markNeedsAdminAction).toHaveBeenCalledOnce(); expect(sessionExpiredCollect).toHaveBeenCalledOnce(); expect(f.auditSink.record).not.toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ stage: "precollection_authentication" }) }));
  });

  it("fails invalid heartbeat configuration during construction before low-level dependencies", () => {
    const f = fixture();
    expect(() => createAuthenticatedIngestionProcessor({ env: { ...env, RD_SYNC_AUTHENTICATION_HEARTBEAT_MS: "60000" }, popularSessionChecker: { check: async () => null }, attempts: {} as never, runnerDependencies: f.runnerDependencies, scrapeRuns: f.scrapeRuns, transactions: { upsertMany: vi.fn() }, resolveScraper: vi.fn(), createOwnerToken: vi.fn() })).toThrow("Invalid authentication heartbeat configuration.");
    expect(f.runnerDependencies.credentials.findByBankCode).not.toHaveBeenCalled();
  });

  it("remains factory-compatible and free of production activation dependencies", async () => {
    const source = await readFile(new URL("./authenticated-ingestion-composition.ts", import.meta.url), "utf8");
    const f = fixture(); const factoryCompatible: (job: { data: unknown }) => Promise<{ status: string; inserted: number; skipped: number }> = f.processor;
    expect(factoryCompatible).toBeTypeOf("function"); expect(source).not.toMatch(/bullmq|prisma|process\.env|from ["'][^"']*ingestion-worker|recoverExpiredSession|from ["'][^"']*queues\/index/i);
  });
});
