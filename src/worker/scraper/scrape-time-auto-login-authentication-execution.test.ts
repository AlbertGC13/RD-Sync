import { describe, expect, it, vi } from "vitest";
import { encryptCredentialField } from "../../modules/bank-credentials/crypto";
import { coordinateAuthenticatedSessionState } from "../../modules/bank-sessions/ensure-authenticated-session";
import { createAuthenticatedSessionMutationRunner, type AuthenticationExecutionResult } from "./authenticated-session-mutation-runner";
import * as autoLogin from "./auto-login";
import { executeScrapeTimeAutoLoginAuthenticationAttempt, type BankAutoLoginOutcome, type BankAutoLoginPage } from "./auto-login";
import { createScrapeTimeAutoLoginAuthenticationExecution, type FencedScrapeTimeAutoLoginRunnerDependencies } from "./scrape-time-auto-login-authentication-execution";

const key = Buffer.alloc(32, 7);
const identity = { bankCode: "popular", runId: "run", attemptId: "attempt" };
const job = { data: { bankId: "popular", runId: "run", accountFingerprint: "fingerprint" } };
const page = { currentUrl: async () => "https://bank/login", hasVisibleSelector: async () => false, fill: vi.fn(), click: vi.fn() };
const base = (outcome: unknown = { status: "succeeded" }): FencedScrapeTimeAutoLoginRunnerDependencies => ({
  adapterRegistry: { get: vi.fn(() => ({ bankCode: "popular", createAutoLoginStrategy: () => ({ bankCode: "popular", autoLogin: vi.fn(async ({ page: durablePage }) => { await durablePage.fill("u", "user"); await durablePage.click("s"); return outcome as BankAutoLoginOutcome; }) }) })) },
  autoLoginConfigs: { getByBankCode: vi.fn().mockResolvedValue({ autoLoginEnabled: true, breakerState: "closed" }) },
  credentials: { findByBankCode: vi.fn().mockResolvedValue({ bankCode: "popular", isActive: true, keyVersion: 1, encryptedUsernameEnvelope: JSON.stringify(encryptCredentialField("user", () => key)), encryptedPasswordEnvelope: JSON.stringify(encryptCredentialField("pass", () => key)) }) },
  keyResolver: () => key, lock: { acquire: vi.fn().mockResolvedValue({ leaseToken: "l", fencingToken: 1, expiresAt: 1 }), release: vi.fn().mockResolvedValue(true) }, cdpUrlForBankCode: () => "http://127.0.0.1:9222", ensureBrowser: vi.fn().mockResolvedValue({ status: "ready", page, close: vi.fn() }),
});
const fakeFence = () => ({ beginCredentialInteraction: vi.fn(), renewBeforeCredentialMutation: vi.fn(), recordSubmitBarrier: vi.fn() });
async function authority(failRenew = false) {
  let phase = "no_credential_interaction" as "no_credential_interaction" | "credentials_may_have_reached_portal" | "submit_may_have_been_dispatched"; const now = new Date();
  const record = (owner = true) => ({ identity, status: "active" as const, interactionPhase: phase, failureClass: null, operatorReason: null, retryCount: 0, ownerToken: owner ? "owner" : null, generation: 0n, leaseExpiresAt: owner ? now : null, terminalAt: null, createdAt: now, updatedAt: now });
  const state = await coordinateAuthenticatedSessionState({ identity, ownerToken: "owner", leaseDurationMs: 1 }, { attempts: {
    findExact: async () => ({ status: "missing" }), getOrCreate: async () => ({ status: "created", record: record(false) }), acquireLease: async () => ({ status: "lease_acquired", owner: { identity, ownerToken: "owner", generation: 0n }, record: record() }), reconcileExpiredLease: async () => ({ status: "missing" }),
    renewLease: async () => failRenew ? { status: "not_applied" } : { status: "lease_renewed", record: record() }, beginCredentialInteraction: async () => { phase = "credentials_may_have_reached_portal"; return { status: "interaction_started", record: record() }; }, recordSubmitBarrier: async () => { phase = "submit_may_have_been_dispatched"; return { status: "recorded", record: record() }; }, claimRetry: async () => ({ status: "retry_claimed", retryCount: 1, record: record(false) }), completeAuthenticated: async () => ({ status: "authenticated", record: record(false) }), completeFailed: async () => ({ status: "failed", record: record(false) }),
  } as never, probe: { observe: async () => ({ status: "unauthenticated" }) }, completion: { mode: "attempt_only" } });
  if (state.status !== "authentication_required") throw new Error("mint");
  return state.authority;
}
async function execute(outcome: unknown): Promise<AuthenticationExecutionResult> {
  const execution = createScrapeTimeAutoLoginAuthenticationExecution({ runnerDependencies: base(outcome), job, identity });
  let result: AuthenticationExecutionResult | undefined;
  await createAuthenticatedSessionMutationRunner({ execution: { execute: async (input) => result = await execution.execute(input) }, heartbeat: { start: () => ({ stop: async () => undefined }) } }).run(await authority());
  if (!result) throw new Error("missing result");
  return result;
}

describe("createScrapeTimeAutoLoginAuthenticationExecution", () => {
  it("validates exact job data without invoking getters or retaining caller data", () => {
    let reads = 0; const getter = { data: { ...job.data } }; Object.defineProperty(getter, "data", { get: () => { reads++; return job.data; } });
    const hidden = { data: { ...job.data } }; Object.defineProperty(hidden.data, "hidden", { value: true }); const dependencies = base();
    const cases = [null, 1, {}, { data: { bankId: "popular", runId: "run" } }, { data: { ...job.data, expiredEventId: undefined } }, { data: { ...job.data, extra: true } }, { data: { ...job.data, bankId: " " } }, { data: { ...job.data, runId: 1 } }, getter, hidden, { data: { ...job.data, [Symbol("x")]: true } }];
    for (const malformed of cases) expect(() => createScrapeTimeAutoLoginAuthenticationExecution({ runnerDependencies: dependencies, job: malformed as never, identity })).toThrow("Invalid authentication execution input");
    expect(reads).toBe(0); expect(dependencies.adapterRegistry.get).not.toHaveBeenCalled();
  });

  it("rejects legacy hook descriptors without evaluating accessors", () => {
    let reads = 0; const dependencies = Object.create({ get beforeAutoLoginMutation() { reads++; return undefined; } }) as ReturnType<typeof base>;
    expect(() => createScrapeTimeAutoLoginAuthenticationExecution({ runnerDependencies: dependencies, job, identity })).toThrow("Invalid authentication execution input");
    expect(reads).toBe(0);
  });

  const outcomeCase = (input: unknown, expected: AuthenticationExecutionResult): [unknown, AuthenticationExecutionResult] => [input, expected];
  const outcomeCases: Array<[unknown, AuthenticationExecutionResult]> = [
    outcomeCase({ status: "succeeded" }, { status: "succeeded" }), outcomeCase({ status: "throttled", safeSummary: "safe" }, { status: "transient_unavailable" }),
    ...["lock_busy", "lock_unavailable"].map((reason) => outcomeCase({ status: "manual_required", reason, safeSummary: "safe" }, { status: "transient_unavailable" })),
    ...["disabled", "breaker_open", "credential_unavailable"].map((reason) => outcomeCase({ status: "skipped", reason, safeSummary: "safe" }, { status: "rejected", cause: "structural_configuration" })),
    outcomeCase("protected_flow", { status: "rejected", cause: "protected_or_mfa" }), outcomeCase("incompatible_flow", { status: "rejected", cause: "incompatible_flow" }),
    ...["unsupported_bank", "credential_bank_mismatch", "missing_required_login_control", "malformed_url", "unauthorized_login_page", "invalid_trigger", "authentication_trigger_not_ready"].map((reason) => outcomeCase(reason, { status: "rejected", cause: "structural_configuration" })),
    ...["auto_login_config_unavailable", "credential_unavailable", "portal_state_unavailable", "browser_unavailable", "auto_login_execution_failed"].map((reason) => outcomeCase(reason, { status: "transient_unavailable" })),
    outcomeCase("unknown_post_submit_state", { status: "rejected", cause: "unknown" }),
  ];
  it.each(outcomeCases)("maps exact outcome %j without summaries", async (input, expected) => {
    const outcome = typeof input === "string" ? { status: "needs_admin_action", reason: input, safeSummary: "secret" } : input;
    const result = await execute(outcome);
    expect(result).toEqual(expected); expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("blocks malformed outcomes, forged fences, pre-abort, and adapter reuse without dependencies", async () => {
    const malformed = [null, 1, { status: "succeeded", safeSummary: "secret" }, { status: "throttled", reason: "wrong", safeSummary: "secret" }, ...["manual_required", "skipped", "needs_admin_action"].flatMap((status) => [{ status, safeSummary: "secret" }, { status, reason: "wrong", safeSummary: "secret" }, { status, reason: "wrong", safeSummary: "secret", password: "secret" }])];
    for (const outcome of malformed) await expect(execute(outcome)).resolves.toEqual({ status: "blocked" });
    await expect(Promise.all(["secret=1", "different summary"].map((safeSummary) => execute({ status: "needs_admin_action", reason: "protected_flow", safeSummary })))).resolves.toEqual([{ status: "rejected", cause: "protected_or_mfa" }, { status: "rejected", cause: "protected_or_mfa" }]);
    const dependencies = base(); const execution = createScrapeTimeAutoLoginAuthenticationExecution({ runnerDependencies: dependencies, job, identity }); const controller = new AbortController(); controller.abort();
    await expect(execution.execute({ fence: fakeFence() as never, signal: controller.signal })).resolves.toEqual({ status: "cancelled" });
    await expect(execution.execute({ fence: fakeFence() as never, signal: new AbortController().signal })).resolves.toEqual({ status: "blocked" });
    expect(dependencies.adapterRegistry.get).not.toHaveBeenCalled();
  });

  it.each([
    [{ durableResult: { status: "blocked" }, runnerFailed: true }, { status: "blocked" }],
    [{ durableResult: { status: "completed", outcome: { status: "succeeded" } }, runnerFailed: true }, { status: "transient_unavailable" }],
    [{ durableResult: { status: "completed", outcome: { status: "needs_admin_action", reason: "protected_flow", safeSummary: "safe" } }, outcome: { status: "succeeded" } }, { status: "rejected", cause: "protected_or_mfa" }],
    [{ outcome: null }, { status: "blocked" }],
  ] as Array<[unknown, AuthenticationExecutionResult]>)("uses durable/runner/result precedence for %j", async (bridgeResult, expected) => {
    const bridge = vi.spyOn(autoLogin, "executeScrapeTimeAutoLoginAuthenticationAttempt").mockResolvedValue(bridgeResult as never); try { await expect(execute({ status: "succeeded" })).resolves.toEqual(expected); } finally { bridge.mockRestore(); }
  });

  it("cancels a pending active adapter when abort precedes a completed bridge capture", async () => {
    let release!: (result: unknown) => void; let tick!: () => Promise<void>; const held = new Promise<unknown>((resolve) => { release = resolve; }); const bridge = vi.spyOn(autoLogin, "executeScrapeTimeAutoLoginAuthenticationAttempt").mockImplementation(async () => held as never); const adapter = createScrapeTimeAutoLoginAuthenticationExecution({ runnerDependencies: base(), job, identity }); let result: AuthenticationExecutionResult | undefined;
    try { await createAuthenticatedSessionMutationRunner({ execution: { execute: async (input) => { const pending = adapter.execute(input); await Promise.resolve(); await tick(); release({ durableResult: { status: "completed", outcome: { status: "succeeded" } } }); result = await pending; return result; } }, heartbeat: { start: (heartbeat) => { tick = heartbeat; return { stop: async () => undefined }; } } }).run(await authority(true)); expect(result).toEqual({ status: "cancelled" }); } finally { bridge.mockRestore(); }
  });

  it("claims a real active fence once before bridge dependencies", async () => {
    let release!: () => void; let started!: () => void; let strategyCalls = 0; const held = new Promise<void>((resolve) => { release = resolve; }); const begun = new Promise<void>((resolve) => { started = resolve; }); const dependencies = base(); dependencies.adapterRegistry.get = vi.fn(() => ({ bankCode: "popular", createAutoLoginStrategy: () => ({ bankCode: "popular", autoLogin: async ({ page: durablePage }: { page: BankAutoLoginPage }) => { strategyCalls++; started(); await held; await durablePage.fill("u", "user"); await durablePage.click("s"); return { status: "succeeded" as const }; } }) })); const adapter = createScrapeTimeAutoLoginAuthenticationExecution({ runnerDependencies: dependencies, job, identity }); const results: AuthenticationExecutionResult[] = []; const calls = () => [dependencies.adapterRegistry.get, dependencies.autoLoginConfigs.getByBankCode, dependencies.credentials.findByBankCode, dependencies.lock!.acquire, dependencies.ensureBrowser].map((call) => (call as unknown as { mock: { calls: unknown[] } }).mock.calls.length);
    await createAuthenticatedSessionMutationRunner({ execution: { execute: async (input) => { const first = adapter.execute(input); await begun; const beforeDuplicate = calls(); const duplicate = await executeScrapeTimeAutoLoginAuthenticationAttempt({ runnerDependencies: dependencies, job, trigger: { kind: "authentication_attempt", id: "a".repeat(64) }, fence: input.fence, signal: input.signal }); expect([duplicate, calls()]).toEqual([{ outcome: null, durableResult: { status: "blocked" } }, beforeDuplicate]); release(); results.push(await first); return results[0]!; } }, heartbeat: { start: () => ({ stop: async () => undefined }) } }).run(await authority());
    expect([results, strategyCalls]).toEqual([[{ status: "succeeded" }], 1]);
  });
});
