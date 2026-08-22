import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { encryptCredentialField } from "../modules/bank-credentials/crypto";
import { createAuthenticatedIngestionProductionProcessor } from "./authenticated-ingestion-production-processor";
import type { BankAutoLoginPage } from "./scraper/auto-login";

describe("createAuthenticatedIngestionProductionProcessor", () => {
  it("composes owned resources into protected post-lock authentication without activation", async () => {
    const order: string[] = [];
    const key = Buffer.alloc(32, 7);
    const identity = { bankCode: "popular", runId: "run-1", attemptId: "attempt-1" };
    let phase = "no_credential_interaction" as "no_credential_interaction" | "credentials_may_have_reached_portal" | "submit_may_have_been_dispatched";
    const now = new Date("2026-08-21T00:00:00.000Z");
    const record = (owner = false) => ({ identity, status: "active" as const, interactionPhase: phase, failureClass: null, operatorReason: null, retryCount: 0, ownerToken: owner ? "owner" : null, generation: 0n, leaseExpiresAt: owner ? now : null, terminalAt: null, createdAt: now, updatedAt: now });
    const attempts = {
      findExact: vi.fn(async () => ({ status: "missing" })), getOrCreate: vi.fn(async () => ({ status: "created", record: record() })), acquireLease: vi.fn(async () => ({ status: "lease_acquired", owner: { identity, ownerToken: "owner", generation: 0n }, record: record(true) })), reconcileExpiredLease: vi.fn(), renewLease: vi.fn(async () => ({ status: "lease_renewed", record: record(true) })), beginCredentialInteraction: vi.fn(async () => { phase = "credentials_may_have_reached_portal"; return { status: "interaction_started", record: record(true) }; }), recordSubmitBarrier: vi.fn(async () => { phase = "submit_may_have_been_dispatched"; return { status: "recorded", record: record(true) }; }), claimRetry: vi.fn(), completeAuthenticated: vi.fn(async () => ({ status: "authenticated", record: { ...record(), status: "authenticated" as const, ownerToken: null, leaseExpiresAt: null, terminalAt: now, generation: 1n } })), completeFailed: vi.fn(),
    };
    const lock = { acquire: vi.fn(async () => { order.push("lock"); return Object.freeze({ signal: new AbortController().signal, release: vi.fn(async () => true) }); }) };
    const page = { protectedStateDetectionWindowMs: 1, currentUrl: async () => "https://bank/login", hasVisibleSelector: async () => false, fill: vi.fn(), click: vi.fn() };
    const resources = {
      authenticationAttempts: attempts, restorationResolver: { resolveObservedRestoration: vi.fn() }, autoLoginConfigs: { getByBankCode: vi.fn(async () => { order.push("config"); return { autoLoginEnabled: true, breakerState: "closed" }; }) }, credentials: { findAuthenticationMaterialByBankCode: vi.fn(async () => { order.push("credential"); return { bankCode: "popular", isActive: true, keyVersion: 1, encryptedUsernameEnvelope: JSON.stringify(encryptCredentialField("user", () => key)), encryptedPasswordEnvelope: JSON.stringify(encryptCredentialField("password", () => key)) }; }) }, credentialKeyResolver: vi.fn(() => { order.push("key"); return key; }), bankAuthenticationLock: lock, scrapeRuns: { markRunning: vi.fn(async () => {}), markSucceeded: vi.fn(async () => {}), markNeedsAdminAction: vi.fn(async () => {}), markThrottled: vi.fn(), markFailed: vi.fn(async () => {}) }, transactions: { upsertMany: vi.fn(async () => ({ inserted: 0, skipped: 0 })) }, auditSink: { record: vi.fn(async () => {}) }, alertSink: { notifyIngestionAttention: vi.fn(async () => {}), notifySessionAttention: vi.fn(async () => {}), notifyCapacityAttention: vi.fn(async () => {}) }, closeLock: vi.fn(), closePrisma: vi.fn(),
    };
    const adapter = Object.freeze({ bankCode: "popular", createAutoLoginStrategy: () => Object.freeze({ bankCode: "popular", autoLogin: async ({ page: target }: { page: BankAutoLoginPage }) => { await target.fill("user", "user"); await target.click("submit"); return { status: "succeeded" as const }; } }) });

    const processor = createAuthenticatedIngestionProductionProcessor(resources as never, {
      env: { RD_SYNC_AUTHENTICATION_LEASE_MS: "60000", RD_SYNC_AUTHENTICATION_HEARTBEAT_MS: "15000" }, popularSessionChecker: { check: async () => ({ status: "expired", checkedAt: now.toISOString(), safeSummary: "safe" }) }, adapterRegistry: { get: vi.fn(() => adapter) }, cdpUrlForBankCode: () => "http://127.0.0.1:9222", ensureBrowser: vi.fn(async () => ({ status: "ready" as const, page, close: vi.fn(async () => {}) })), resolveScraper: vi.fn(() => ({ collect: vi.fn(async () => ({ status: "collected" as const, movements: [] })) })), createOwnerToken: () => "owner", heartbeat: { schedule: vi.fn(() => ({})), cancel: vi.fn() }, now: () => now,
    });

    expect(lock.acquire).not.toHaveBeenCalled();
    await expect(processor({ data: { runId: "run-1", bankId: "popular", accountFingerprint: "fingerprint", authentication: { version: 1, attemptId: "attempt-1" } } })).resolves.toEqual({ status: "succeeded", inserted: 0, skipped: 0 });
    expect(order).toEqual(["lock", "config", "credential", "key"]);
    expect(page.fill).toHaveBeenCalledOnce();
    expect(resources.auditSink.record).toHaveBeenCalledWith(expect.objectContaining({ action: "bank_credential.decrypt_use" }));
    expect(resources.closeLock).not.toHaveBeenCalled(); expect(resources.closePrisma).not.toHaveBeenCalled();
  });

  it("has no production caller, worker activation, or ambient configuration", async () => {
    const source = await readFile(new URL("./authenticated-ingestion-production-processor.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/bullmq|process\.env|ingestion-worker|createAuthenticatedIngestionProductionResources|closeLock\(\)|closePrisma\(\)/i);
  });
});
