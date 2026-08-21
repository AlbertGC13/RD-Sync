import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { coordinateAuthenticatedSessionState } from "../../modules/bank-sessions/ensure-authenticated-session";
import type { AuthenticationMutationAuthority } from "../../modules/bank-sessions/authentication-mutation-authority";
import type { SessionAuthenticationAttemptRepository } from "../../modules/bank-sessions/session-authentication-attempt-repository";
import { createAuthenticatedSessionMutationRunner, type CredentialMutationFence } from "./authenticated-session-mutation-runner";
import { createProtectedAutoLoginExecution } from "./protected-auto-login-execution";
import { createStrictAutoLoginCredentialLoader, type StrictAutoLoginCredential } from "./strict-auto-login-credential-loader";

const identity = Object.freeze({ bankCode: "popular", runId: "run", attemptId: "attempt" });
const job = Object.freeze({ bankCode: "popular", runId: "run", accountFingerprint: "fingerprint" });
const page = (events: string[]) => ({ currentUrl: async () => "https://bank.example/login", hasVisibleSelector: async () => false, protectedStateDetectionWindowMs: 1, fill: async (...[selector]: [string, string]) => { events.push(`fill:${selector}`); }, click: async (selector: string) => { events.push(`click:${selector}`); } });
const credential = async (): Promise<StrictAutoLoginCredential> => {
  const result = await createStrictAutoLoginCredentialLoader({ findAuthenticationMaterialByBankCode: async () => ({ bankCode: "popular", isActive: true, keyVersion: 1, encryptedUsernameEnvelope: JSON.stringify({ keyVersion: 1, iv: "i", ciphertext: "u", tag: "t" }), encryptedPasswordEnvelope: JSON.stringify({ keyVersion: 1, iv: "i", ciphertext: "p", tag: "t" }) }), resolveKey: () => Buffer.alloc(32), decrypt: vi.fn().mockReturnValueOnce("user").mockReturnValueOnce("password"), recordDecryptUse: async () => undefined }).load("popular");
  if (result.status !== "loaded") throw new Error("credential fixture failed");
  return result.credential;
};
function dependencies(events: string[], overrides: Record<string, unknown> = {}) {
  const ready = { status: "ready" as const, page: page(events), close: async function () { events.push(this === ready ? "close" : "bad-close"); } };
  const ensureBrowser = vi.fn(async () => ready);
  const adapter = Object.freeze({ bankCode: "popular", createAutoLoginStrategy: vi.fn(() => ({ bankCode: "popular", autoLogin: async ({ page: wrapped }: { page: ReturnType<typeof page> }) => { await wrapped.fill("user", "user"); await wrapped.fill("password", "password"); await wrapped.click("submit"); return { status: "succeeded" as const }; } })) });
  return { ...Object.freeze({ job, identity, credential: undefined as unknown as StrictAutoLoginCredential, fence: undefined as unknown as CredentialMutationFence, signal: new AbortController().signal, cdpUrl: "http://127.0.0.1:9222", adapter, ensureBrowser }), ...overrides };
}
function repository(): SessionAuthenticationAttemptRepository {
  const now = new Date(); const record = (phase = "no_credential_interaction", owner = true) => ({ identity, status: "active" as const, interactionPhase: phase as "no_credential_interaction" | "credentials_may_have_reached_portal" | "submit_may_have_been_dispatched", failureClass: null, operatorReason: null, retryCount: 0, ownerToken: owner ? "owner" : null, generation: 0n, leaseExpiresAt: owner ? now : null, terminalAt: null, createdAt: now, updatedAt: now }); let phase = "no_credential_interaction";
  return { findExact: async () => ({ status: "missing" }), getOrCreate: async () => ({ status: "created", record: record("no_credential_interaction", false) }), acquireLease: async () => ({ status: "lease_acquired", owner: { identity, ownerToken: "owner", generation: 0n }, record: record() }), reconcileExpiredLease: async () => ({ status: "missing" }), renewLease: async () => ({ status: "lease_renewed", record: record(phase) }), beginCredentialInteraction: async () => { phase = "credentials_may_have_reached_portal"; return { status: "interaction_started", record: record(phase) }; }, recordSubmitBarrier: async () => { phase = "submit_may_have_been_dispatched"; return { status: "recorded", record: record(phase) }; }, claimRetry: async () => ({ status: "retry_claimed", retryCount: 1, record: { ...record(phase, false), generation: 1n, retryCount: 1 } }), completeAuthenticated: async () => ({ status: "authenticated", record: { ...record(phase, false), status: "authenticated" as const, generation: 1n, terminalAt: now } }), completeFailed: async () => ({ status: "failed", record: { ...record(phase, false), status: "failed" as const, generation: 1n, terminalAt: now, failureClass: "unclassified_failure", operatorReason: "authentication_attempt_requires_review" } }) } as unknown as SessionAuthenticationAttemptRepository;
}
async function withFence(run: (fence: CredentialMutationFence, signal: AbortSignal) => Promise<unknown>, cancellationSignal?: AbortSignal) {
  const authority = await coordinateAuthenticatedSessionState({ identity, ownerToken: "owner", leaseDurationMs: 1 }, { attempts: repository(), probe: { observe: async () => ({ status: "unauthenticated" }) }, completion: { mode: "attempt_only" } });
  if (authority.status !== "authentication_required") throw new Error("authority fixture failed");
  return createAuthenticatedSessionMutationRunner({ cancellationSignal, heartbeat: { start: () => ({ stop: async () => undefined }) }, execution: { execute: async ({ fence, signal }) => { const result = await run(fence, signal) as { status?: string; outcome?: { status?: string } }; return result.status === "completed" && result.outcome?.status === "succeeded" ? { status: "succeeded" as const } : { status: "blocked" as const }; } } }).run(authority.authority as AuthenticationMutationAuthority);
}

describe("createProtectedAutoLoginExecution", () => {
  it("fails closed before opening for malformed, mismatched, forged, consumed, proxy, pre-aborted, adapter, and CDP inputs", async () => {
    const events: string[] = []; const base = dependencies(events); const goodCredential = await credential();
    for (const change of [{ job: { ...job, runId: "other" } }, { identity: { ...identity, bankCode: "other" } }, { credential: Object.freeze({ ...goodCredential, bankCode: "other" }) }, { fence: {} }, { signal: new Proxy(new AbortController().signal, {}) }, { signal: (() => { const c = new AbortController(); c.abort(); return c.signal; })() }, { adapter: { bankCode: "other", createAutoLoginStrategy() {} } }, { cdpUrl: "https://bank.example" }]) {
      await expect(createProtectedAutoLoginExecution({ ...base, credential: goodCredential, ...change }).execute()).resolves.toEqual({ status: "blocked" });
    }
    expect(base.ensureBrowser).not.toHaveBeenCalled();
  });
  it("contains browser failures and validates exact throttled and ready resources", async () => {
    for (const response of ["throw", { status: "throttled", extra: true }, { status: "ready", page: page([]), close: async () => undefined, extra: true }]) {
      const events: string[] = []; const base = dependencies(events, { ensureBrowser: async () => { if (response === "throw") throw new Error("password=secret"); return response; } });
      await withFence(async (fence, signal) => createProtectedAutoLoginExecution({ ...base, credential: await credential(), fence, signal }).execute());
      expect(events).toEqual([]);
    }
  });
  it("returns only the bounded throttled result for an exact browser throttle", async () => {
    const base = dependencies([], { ensureBrowser: async () => ({ status: "throttled" }) }); let output: unknown;
    await withFence(async (fence, signal) => { output = await createProtectedAutoLoginExecution({ ...base, credential: await credential(), fence, signal }).execute(); return output; });
    expect(output).toEqual({ status: "throttled" });
  });
  it("executes once through the real durable fence with the exact signal and closes its ready browser once", async () => {
    const events: string[] = []; const base = dependencies(events);
    const result = await withFence(async (fence, signal) => createProtectedAutoLoginExecution({ ...base, credential: await credential(), fence, signal }).execute());
    expect([result, base.adapter.createAutoLoginStrategy.mock.calls.length, events]).toEqual([{ status: "authenticated" }, 1, ["fill:user", "fill:password", "click:submit", "close"]]);
  });
  it("blocks malformed or secret-bearing durable outcomes and strategy or close failures without leaking values", async () => {
    const events: string[] = []; const base = dependencies(events, { adapter: Object.freeze({ bankCode: "popular", createAutoLoginStrategy: () => { throw new Error("token=secret"); } }) });
    let output: unknown; await withFence(async (fence, signal) => { output = await createProtectedAutoLoginExecution({ ...base, credential: await credential(), fence, signal }).execute(); return output; });
    expect([output, JSON.stringify(output), events]).toEqual([{ status: "structural_configuration" }, "{\"status\":\"structural_configuration\"}", ["close"]]);
  });
  it("swallows a throwing close without changing its validated result", async () => {
    const events: string[] = []; const base = dependencies(events); const opened = await base.ensureBrowser(); opened.close = async () => { throw new Error("token=secret"); };
    let output: unknown; await withFence(async (fence, signal) => { output = await createProtectedAutoLoginExecution({ ...base, credential: await credential(), fence, signal }).execute(); return output; });
    expect([output, JSON.stringify(output)]).toEqual([{ status: "completed", outcome: { status: "succeeded" } }, "{\"status\":\"completed\",\"outcome\":{\"status\":\"succeeded\"}}"]);
  });
  it.each(["before", "between", "submit"])("uses the real durable wrapper to stop raw mutations when external loss arrives %s", async (at) => {
    const events: string[] = []; const cancellation = new AbortController(); const base = dependencies(events, { adapter: Object.freeze({ bankCode: "popular", createAutoLoginStrategy: () => ({ bankCode: "popular", autoLogin: async ({ page: wrapped }: { page: ReturnType<typeof page> }) => { if (at === "before") cancellation.abort(); try { await wrapped.fill("user", "user"); if (at === "between") cancellation.abort(); await wrapped.fill("password", "password"); if (at === "submit") cancellation.abort(); await wrapped.click("submit"); } catch {} return { status: "succeeded" as const }; } }) }) });
    await withFence(async (fence, signal) => createProtectedAutoLoginExecution({ ...base, credential: await credential(), fence, signal }).execute(), cancellation.signal);
    expect(events.filter((event) => event.startsWith("fill") || event.startsWith("click"))).toEqual(at === "before" ? [] : at === "between" ? ["fill:user"] : ["fill:user", "fill:password"]);
  });
  it("has no legacy activation, lock, decrypt, repository, audit, or breaker dependency", async () => {
    const source = await readFile(new URL("./protected-auto-login-execution.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/bank-auto-login-lock|credential.*(?:repository|crypto)|decrypt|legacy.*(?:runner|trigger)|audit|breaker/i);
    expect(source).not.toMatch(/executeScrapeTimeAutoLoginAuthenticationAttempt|createScrapeTimeAutoLoginAuthenticationExecution/);
  });
});
