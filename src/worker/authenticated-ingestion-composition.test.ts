import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { encryptCredentialField } from "../modules/bank-credentials/crypto";
import {
  AuthenticatedIngestionRetryError,
  AuthenticatedIngestionTerminalError,
} from "./authenticated-ingestion-delivery";
import { createAuthenticatedIngestionProcessor } from "./authenticated-ingestion-composition";
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
  const collect = vi.fn(async () => ({ status: "collected" as const, movements: [] }));
  const createOwnerToken = vi.fn().mockReturnValueOnce("owner-1").mockReturnValueOnce("owner-2");
  const processor = createAuthenticatedIngestionProcessor({
    env, popularSessionChecker: { check: async () => ({ status: authenticated ? "active" : "expired", checkedAt: "2026-08-21T00:00:00.000Z", safeSummary: "safe" }) },
    attempts: { findExact: async () => authenticated ? { status: "found", record: record() } : { status: "missing" }, getOrCreate: async () => ({ status: "created", record: record() }), acquireLease: async (input: { ownerToken: string }) => { ownerToken = input.ownerToken; return { status: "lease_acquired", owner: { identity, ownerToken, generation: 0n }, record: record(true) }; }, reconcileExpiredLease: async () => ({ status: "missing" }), renewLease: async () => ({ status: "lease_renewed", record: record(true) }), beginCredentialInteraction: async () => { phase = "credentials_may_have_reached_portal"; return { status: "interaction_started", record: record(true) }; }, recordSubmitBarrier: async () => { phase = "submit_may_have_been_dispatched"; return { status: "recorded", record: record(true) }; }, claimRetry: async () => ({ status: "retry_claimed", retryCount: 1 as const, record: record() }), completeAuthenticated: async () => { authenticated = true; return { status: "authenticated", record: record() }; }, completeFailed: async () => ({ status: "failed", record: record() }) } as never,
    runnerDependencies, heartbeat: scheduler, scrapeRuns, transactions: { upsertMany: vi.fn(async () => ({ inserted: 0, skipped: 0 })) }, resolveScraper: vi.fn(() => ({ collect })), createOwnerToken, now: () => now, ...overrides,
  });
  return { processor, page, scheduler, runnerDependencies, scrapeRuns, collect, createOwnerToken };
}

describe("createAuthenticatedIngestionProcessor", () => {
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
    await expect(f.processor({ ...payload(), signal: controller.signal })).rejects.toEqual(new AuthenticatedIngestionRetryError("cancelled"));
    expect(f.runnerDependencies.credentials.findByBankCode).not.toHaveBeenCalled(); expect(f.collect).not.toHaveBeenCalled();
  });

  it("does not authenticate or collect when cancellation arrives during a session check", async () => {
    let resolve!: (result: unknown) => void;
    const pending = new Promise<unknown>((done) => { resolve = done; });
    const f = fixture({ popularSessionChecker: { check: async () => pending } }); const controller = new AbortController();
    const result = f.processor({ ...payload(), signal: controller.signal }); controller.abort(); resolve({ status: "active", checkedAt: "2026-08-21T00:00:00.000Z", safeSummary: "safe" });
    await expect(result).rejects.toBeInstanceOf(AuthenticatedIngestionRetryError);
    expect(f.runnerDependencies.credentials.findByBankCode).not.toHaveBeenCalled(); expect(f.collect).not.toHaveBeenCalled();
  });

  it("makes a collection session expiry terminal once without recovery or recollection", async () => {
    const sessionExpiredCollect = vi.fn(async () => ({ status: "needs_admin_action" as const, cause: "session_expired" as const, movements: [] }));
    const f = fixture({ resolveScraper: vi.fn(() => ({ collect: sessionExpiredCollect })) });
    await expect(f.processor(payload())).resolves.toEqual({ status: "needs_admin_action", inserted: 0, skipped: 0 });
    expect(f.scrapeRuns.markNeedsAdminAction).toHaveBeenCalledOnce(); expect(sessionExpiredCollect).toHaveBeenCalledOnce();
  });

  it("fails invalid heartbeat configuration during construction before low-level dependencies", () => {
    const f = fixture();
    expect(() => createAuthenticatedIngestionProcessor({ env: { ...env, RD_SYNC_AUTHENTICATION_HEARTBEAT_MS: "60000" }, popularSessionChecker: { check: async () => null }, attempts: {} as never, runnerDependencies: f.runnerDependencies, scrapeRuns: f.scrapeRuns, transactions: { upsertMany: vi.fn() }, resolveScraper: vi.fn(), createOwnerToken: vi.fn() })).toThrow("Invalid authentication heartbeat configuration.");
    expect(f.runnerDependencies.credentials.findByBankCode).not.toHaveBeenCalled();
  });

  it("remains factory-compatible and free of production activation dependencies", async () => {
    const source = await readFile(new URL("./authenticated-ingestion-composition.ts", import.meta.url), "utf8");
    const f = fixture(); const factoryCompatible: (job: { data: unknown }) => Promise<{ status: string; inserted: number; skipped: number }> = f.processor;
    expect(factoryCompatible).toBeTypeOf("function"); expect(source).not.toMatch(/bullmq|prisma|process\.env|ingestion-worker|recoverExpiredSession|from ["'][^"']*queues\/index/i);
  });
});
