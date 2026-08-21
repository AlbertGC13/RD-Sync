import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { encryptCredentialField } from "../modules/bank-credentials/crypto";
import {
  createAuthenticatedIngestionPrecondition,
  type AuthenticatedIngestionPreconditionDependencies,
} from "./authenticated-ingestion-precondition";
import type { FencedScrapeTimeAutoLoginRunnerDependencies } from "./scraper/scrape-time-auto-login-authentication-execution";
import type { BankAutoLoginPage } from "./scraper/auto-login";

const identity = { bankCode: "popular", runId: "run-1", attemptId: "attempt-1" };
const env = { RD_SYNC_AUTHENTICATION_LEASE_MS: "60000", RD_SYNC_AUTHENTICATION_HEARTBEAT_MS: "15000" };
const key = Buffer.alloc(32, 7);

function deferred<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((done) => { resolve = done; }), resolve };
}

function createFixture() {
  let phase = "no_credential_interaction" as "no_credential_interaction" | "credentials_may_have_reached_portal" | "submit_may_have_been_dispatched";
  let authenticated = false;
  const now = new Date();
  const record = (owner = false) => authenticated
    ? { identity, status: "authenticated" as const, interactionPhase: phase, failureClass: null, operatorReason: null, retryCount: 0, ownerToken: null, generation: 1n, leaseExpiresAt: null, terminalAt: now, createdAt: now, updatedAt: now }
    : { identity, status: "active" as const, interactionPhase: phase, failureClass: null, operatorReason: null, retryCount: 0, ownerToken: owner ? "owner-token" : null, generation: 0n, leaseExpiresAt: owner ? now : null, terminalAt: null, createdAt: now, updatedAt: now };
  const page = { currentUrl: async () => "https://bank/login", hasVisibleSelector: async () => false, fill: vi.fn(), click: vi.fn() };
  const scheduler = { schedule: vi.fn(() => ({})), cancel: vi.fn() };
  const runnerDependencies: FencedScrapeTimeAutoLoginRunnerDependencies = {
    adapterRegistry: { get: vi.fn(() => ({ bankCode: "popular", createAutoLoginStrategy: () => ({ bankCode: "popular", autoLogin: async ({ page: guardedPage }: { page: BankAutoLoginPage }) => { await guardedPage.fill("username", "user"); await guardedPage.click("submit"); return { status: "succeeded" as const }; } }) })) },
    autoLoginConfigs: { getByBankCode: vi.fn().mockResolvedValue({ autoLoginEnabled: true, breakerState: "closed" }) },
    credentials: { findByBankCode: vi.fn().mockResolvedValue({ bankCode: "popular", isActive: true, keyVersion: 1, encryptedUsernameEnvelope: JSON.stringify(encryptCredentialField("user", () => key)), encryptedPasswordEnvelope: JSON.stringify(encryptCredentialField("pass", () => key)) }) },
    keyResolver: () => key, lock: { acquire: vi.fn().mockResolvedValue({ leaseToken: "lease", fencingToken: 1, expiresAt: 1 }), release: vi.fn().mockResolvedValue(true) }, cdpUrlForBankCode: () => "http://127.0.0.1:9222", ensureBrowser: vi.fn().mockResolvedValue({ status: "ready", page, close: vi.fn() }),
  };
  const dependencies: AuthenticatedIngestionPreconditionDependencies = {
    env,
    coordinatorDependencies: { attempts: {
      findExact: async () => authenticated ? { status: "found", record: record() } : { status: "missing" }, getOrCreate: async () => ({ status: "created", record: record() }), acquireLease: async () => ({ status: "lease_acquired", owner: { identity, ownerToken: "owner-token", generation: 0n }, record: record(true) }), reconcileExpiredLease: async () => ({ status: "missing" }),
      renewLease: async () => ({ status: "lease_renewed", record: record(true) }), beginCredentialInteraction: async () => { phase = "credentials_may_have_reached_portal"; return { status: "interaction_started", record: record(true) }; }, recordSubmitBarrier: async () => { phase = "submit_may_have_been_dispatched"; return { status: "recorded", record: record(true) }; }, claimRetry: async () => ({ status: "retry_claimed", retryCount: 1 as const, record: record() }), completeAuthenticated: async () => { authenticated = true; return { status: "authenticated", record: record() }; }, completeFailed: async () => ({ status: "failed", record: record() }),
    } as never, probe: { observe: async () => ({ status: "unauthenticated" as const }) } },
    runnerDependencies, job: { data: { bankId: "popular", runId: "run-1", accountFingerprint: "fingerprint" } }, heartbeat: scheduler,
  };
  return { dependencies, precondition: createAuthenticatedIngestionPrecondition(dependencies), page, scheduler, runnerDependencies, authenticate: () => { authenticated = true; } };
}

describe("createAuthenticatedIngestionPrecondition", () => {
  it("uses real coordinator, runner, adapter, and scheduler once before durable duplicate bypass", async () => {
    const fixture = createFixture();

    await expect(fixture.precondition({ identity, ownerToken: "owner-token" })).resolves.toEqual({ status: "authenticated" });
    await expect(fixture.precondition({ identity, ownerToken: "owner-token" })).resolves.toEqual({ status: "authenticated" });
    expect(fixture.page.fill).toHaveBeenCalledOnce();
    expect(fixture.page.click).toHaveBeenCalledOnce();
    expect(fixture.scheduler.schedule).toHaveBeenCalledOnce();
    expect(fixture.scheduler.cancel).toHaveBeenCalledOnce();
    expect(fixture.runnerDependencies.credentials.findByBankCode).toHaveBeenCalledOnce();
  });

  it("fails closed for hostile signal getters without leaking sentinels or activating dependencies", async () => {
    const sentinel = "raw-signal-sentinel owner-token";
    const prototype = Object.create(AbortSignal.prototype);
    Object.defineProperty(prototype, "aborted", { enumerable: true, get: () => { throw new Error(sentinel); } });
    const signal = Object.create(prototype);
    const fixture = createFixture();

    const result = await fixture.precondition({ identity, ownerToken: "owner-token", signal });
    expect(result).toEqual({ status: "invalid_request" });
    expect(JSON.stringify(result)).not.toContain(sentinel);
    expect(fixture.runnerDependencies.credentials.findByBankCode).not.toHaveBeenCalled();
    expect(fixture.scheduler.schedule).not.toHaveBeenCalled();
  });

  it("rejects a non-throwing AbortSignal prototype spoof before mutation", async () => {
    const spoof = Object.create(AbortSignal.prototype); Object.defineProperty(spoof, "aborted", { value: false });
    const fixture = createFixture();
    await expect(fixture.precondition({ identity, ownerToken: "owner-token", signal: spoof })).resolves.toEqual({ status: "invalid_request" });
    expect(fixture.runnerDependencies.credentials.findByBankCode).not.toHaveBeenCalled(); expect(fixture.scheduler.schedule).not.toHaveBeenCalled();
  });

  it("uses EventTarget intrinsics instead of overridden signal event methods", async () => {
    const controller = new AbortController(); const add = vi.fn(() => { throw new Error("raw-listener-sentinel"); }); const remove = vi.fn(() => { throw new Error("raw-listener-sentinel"); });
    Object.defineProperties(controller.signal, { addEventListener: { value: add }, removeEventListener: { value: remove } });
    const fixture = createFixture();
    await expect(fixture.precondition({ identity, ownerToken: "owner-token", signal: controller.signal })).resolves.toEqual({ status: "authenticated" });
    expect(add).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
  });

  it("bridges a real delivery abort into fenced execution without later credential interaction", async () => {
    const pending = deferred<{ status: "ready"; page: BankAutoLoginPage; close(): Promise<void> }>(); const started = deferred<void>();
    const fixture = createFixture(); fixture.runnerDependencies.ensureBrowser = vi.fn(async () => { started.resolve(); return pending.promise as never; });
    const controller = new AbortController(); const result = fixture.precondition({ identity, ownerToken: "owner-token", signal: controller.signal });
    await started.promise; controller.abort(); pending.resolve({ status: "ready", page: fixture.page, close: async () => {} });
    await expect(result).resolves.toEqual(expect.objectContaining({ status: expect.not.stringMatching(/^authenticated$/) }));
    expect(fixture.page.fill).not.toHaveBeenCalled(); expect(fixture.page.click).not.toHaveBeenCalled(); expect(fixture.scheduler.cancel).toHaveBeenCalledOnce();
  });

  it("supports real AbortSignal while pre-abort bypasses all mutation dependencies", async () => {
    const controller = new AbortController();
    controller.abort();
    const fixture = createFixture();

    await expect(fixture.precondition({ identity, ownerToken: "owner-token", signal: controller.signal })).resolves.toEqual({ status: "cancelled" });
    expect(fixture.runnerDependencies.credentials.findByBankCode).not.toHaveBeenCalled();
    expect(fixture.scheduler.schedule).not.toHaveBeenCalled();
  });

  it("does not impose a wrapper length limit on a domain-valid identity", async () => {
    const fixture = createFixture();
    fixture.authenticate();
    const longIdentity = { ...identity, attemptId: "a".repeat(257) };

    await expect(fixture.precondition({ identity: longIdentity, ownerToken: "owner-token" })).resolves.toEqual({ status: "authenticated" });
    expect(fixture.scheduler.schedule).not.toHaveBeenCalled();
  });

  it.each([null, [], { identity, ownerToken: "" }, { identity, ownerToken: "owner-token", extra: true }, { identity: { ...identity, runId: "wrong" }, ownerToken: "owner-token" }])("rejects malformed invocation %# before dependencies", async (input) => {
    const fixture = createFixture();

    await expect(fixture.precondition(input)).resolves.toEqual({ status: "invalid_request" });
    expect(fixture.scheduler.schedule).not.toHaveBeenCalled();
  });

  it("fails invalid construction and keeps the module inert", () => {
    const source = readFileSync(new URL("./authenticated-ingestion-precondition.ts", import.meta.url), "utf8");
    const fixture = createFixture();

    expect(() => createAuthenticatedIngestionPrecondition({ ...fixture.dependencies, env: { ...env, RD_SYNC_AUTHENTICATION_HEARTBEAT_MS: "60000" } })).toThrow("Invalid authentication heartbeat configuration.");
    expect(() => createAuthenticatedIngestionPrecondition({ ...fixture.dependencies, job: { data: { bankId: "popular", runId: "run-1", accountFingerprint: "fingerprint", expiredEventId: "legacy" } } })).toThrow("Invalid authenticated ingestion precondition configuration.");
    expect(source).toContain('completion: { mode: "attempt_only" }');
    expect(source).toContain("cancellationSignal: invocation.signal"); expect(source).not.toContain("new AbortController");
    expect(source).not.toMatch(/BullMQ|Prisma|process\.env|createCoordinator|createExecution|createRunner/);
  });
});
