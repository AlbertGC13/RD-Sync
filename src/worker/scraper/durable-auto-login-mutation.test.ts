import { describe, expect, it } from "vitest";
import { createBankAutoLoginStrategy, type BankAutoLoginPage, type BankAutoLoginStrategy } from "./auto-login";
import { executeDurablyFencedAutoLogin } from "./durable-auto-login-mutation";
import type {
  BeginCredentialInteractionResult,
  RecordSessionAuthenticationSubmitBarrierResult,
  RenewSessionAuthenticationLeaseResult,
  SessionAuthenticationAttemptRepository,
  SessionAuthenticationLeaseOwner,
} from "../../modules/bank-sessions/session-authentication-attempt-repository";

const owner: SessionAuthenticationLeaseOwner = { identity: { bankCode: "popular", runId: "run", attemptId: "attempt" }, ownerToken: "owner", generation: 1n };
const credential = { bankCode: "popular", username: "alice", password: "secret" };
const record = {} as never;
type Status = "interaction_started" | "already_started" | "lease_renewed" | "recorded" | "already_recorded" | "invalid_transition" | "stale_owner" | "lease_expired" | "terminal" | "missing" | "not_applied";
type DurableInput = Parameters<typeof executeDurablyFencedAutoLogin>[0];
type DurableOutput = Awaited<ReturnType<typeof executeDurablyFencedAutoLogin>>;
const attemptsSurfaceIsNarrow: Exclude<keyof DurableInput["attempts"], "beginCredentialInteraction" | "renewLease" | "recordSubmitBarrier"> extends never ? true : false = true;
const outputDoesNotExposeRawPage: "page" extends keyof DurableOutput ? false : true = true;
void attemptsSurfaceIsNarrow;
void outputDoesNotExposeRawPage;

function page(events: string[], overrides: Partial<BankAutoLoginPage> = {}): BankAutoLoginPage {
  return {
    currentUrl: async () => "https://bank.example/login",
    hasVisibleSelector: async () => false,
    protectedStateDetectionWindowMs: 321,
    fill: async (selector, value) => { events.push(`fill:${selector}:${value}`); },
    click: async (selector) => { events.push(`click:${selector}`); },
    ...overrides,
  };
}

function attempts(events: string[], statuses: Partial<Record<"begin" | "renew" | "barrier", Status>> = {}) {
  return {
    beginCredentialInteraction: async () => { events.push("begin"); return { status: statuses.begin ?? "interaction_started", record } as unknown as BeginCredentialInteractionResult; },
    renewLease: async () => { events.push("renew"); return { status: statuses.renew ?? "lease_renewed", record } as unknown as RenewSessionAuthenticationLeaseResult; },
    recordSubmitBarrier: async () => { events.push("barrier"); return { status: statuses.barrier ?? "recorded", record } as unknown as RecordSessionAuthenticationSubmitBarrierResult; },
  } satisfies Pick<SessionAuthenticationAttemptRepository, "beginCredentialInteraction" | "renewLease" | "recordSubmitBarrier">;
}

function strategy(run: (page: BankAutoLoginPage) => Promise<void>, outcome: ReturnType<BankAutoLoginStrategy["autoLogin"]> extends Promise<infer Result> ? Result : never = { status: "succeeded" }): BankAutoLoginStrategy {
  return { bankCode: "popular", autoLogin: async ({ page }) => { try { await run(page); return outcome; } catch { return { status: "needs_admin_action", reason: "portal_state_unavailable", safeSummary: "safe" }; } } };
}

function execute(events: string[], run: (page: BankAutoLoginPage) => Promise<void>, statuses = {}, raw = page(events)) {
  return executeDurablyFencedAutoLogin({ strategy: strategy(run), credential, page: raw, attempts: attempts(events, statuses), owner, leaseDurationMs: 1_000 });
}

describe("executeDurablyFencedAutoLogin", () => {
  it("begins before the first raw fill and records the credential phase", async () => {
    const events: string[] = [];
    const result = await execute(events, async (p) => { await p.fill("user", "alice"); });
    expect(events).toEqual(["begin", "fill:user:alice"]);
    expect(result).toMatchObject({ status: "completed", interactionPhase: "credentials_may_have_reached_portal" });
  });

  it.each(["already_started", "stale_owner", "lease_expired", "terminal", "missing", "not_applied"] as const)("blocks a non-authorizing begin result: %s", async (begin) => {
    const events: string[] = [];
    const result = await execute(events, async (p) => { await p.fill("user", "alice"); }, { begin });
    expect(events).toEqual(["begin"]);
    expect(result).toMatchObject({ status: "blocked", interactionPhase: "no_credential_interaction" });
  });

  it("blocks a begin failure without serializing its error", async () => {
    const events: string[] = [];
    const result = await executeDurablyFencedAutoLogin({ strategy: strategy(async (p) => { await p.fill("user", "alice"); }), credential, page: page(events), attempts: { ...attempts(events), beginCredentialInteraction: async () => { throw new Error("token=raw-secret"); } }, owner, leaseDurationMs: 1 });
    expect(JSON.stringify(result)).not.toContain("raw-secret");
    expect(result).toMatchObject({ status: "blocked", reason: "persistence_unavailable" });
  });

  it("renews immediately before every later non-empty fill", async () => {
    const events: string[] = [];
    await execute(events, async (p) => { await p.fill("user", "alice"); await p.fill("password", "secret"); });
    expect(events).toEqual(["begin", "fill:user:alice", "renew", "fill:password:secret"]);
  });

  it.each(["stale_owner", "lease_expired", "terminal", "missing", "not_applied"] as const)("blocks a non-authorizing renewal: %s", async (renew) => {
    const events: string[] = [];
    const result = await execute(events, async (p) => { await p.fill("user", "alice"); await p.fill("password", "secret"); }, { renew });
    expect(events).toEqual(["begin", "fill:user:alice", "renew"]);
    expect(result).toMatchObject({ status: "blocked", interactionPhase: "credentials_may_have_reached_portal" });
  });

  it("blocks renewal persistence failure", async () => {
    const events: string[] = [];
    const result = await executeDurablyFencedAutoLogin({ strategy: strategy(async (p) => { await p.fill("user", "alice"); await p.fill("password", "secret"); }), credential, page: page(events), attempts: { ...attempts(events), renewLease: async () => { events.push("renew"); throw new Error("database-url"); } }, owner, leaseDurationMs: 1 });
    expect(events).toEqual(["begin", "fill:user:alice", "renew"]);
    expect(result).toMatchObject({ status: "blocked", reason: "persistence_unavailable" });
  });

  it("places the submit barrier immediately before the raw click", async () => {
    const events: string[] = [];
    await execute(events, async (p) => { await p.click("submit"); });
    expect(events).toEqual(["barrier", "click:submit"]);
  });

  it.each(["already_recorded", "invalid_transition", "stale_owner", "lease_expired", "terminal", "missing", "not_applied"] as const)("blocks every non-authorizing barrier: %s", async (barrier) => {
    const events: string[] = [];
    const result = await execute(events, async (p) => { await p.click("submit"); }, { barrier });
    expect(events).toEqual(["barrier"]);
    expect(result).toMatchObject({ status: "blocked", interactionPhase: "no_credential_interaction" });
  });

  it("blocks barrier failure and a click error with safe submit-phase uncertainty", async () => {
    const barrierEvents: string[] = [];
    const barrierResult = await executeDurablyFencedAutoLogin({ strategy: strategy(async (p) => { await p.click("submit"); }), credential, page: page(barrierEvents), attempts: { ...attempts(barrierEvents), recordSubmitBarrier: async () => { throw new Error("token"); } }, owner, leaseDurationMs: 1 });
    expect(barrierEvents).toEqual([]);
    expect(barrierResult).toMatchObject({ status: "blocked", reason: "persistence_unavailable" });
    const clickEvents: string[] = [];
    const clickResult = await execute(clickEvents, async (p) => { await p.click("submit"); }, {}, page(clickEvents, { click: async () => { clickEvents.push("click"); throw new Error("https://private"); } }));
    expect(clickResult).toMatchObject({ status: "blocked", interactionPhase: "submit_may_have_been_dispatched" });
    expect(JSON.stringify(clickResult)).not.toContain("private");
  });

  it("retains submit uncertainty for an unknown post-submit strategy outcome", async () => {
    const events: string[] = [];
    const result = await executeDurablyFencedAutoLogin({ strategy: strategy(async (p) => { await p.click("submit"); }, { status: "needs_admin_action", reason: "unknown_post_submit_state", safeSummary: "safe" }), credential, page: page(events), attempts: attempts(events), owner, leaseDurationMs: 1 });
    expect(result).toMatchObject({ status: "completed", interactionPhase: "submit_may_have_been_dispatched" });
  });

  it("does not let a strategy catch swallow a durable denial", async () => {
    const events: string[] = [];
    const result = await execute(events, async (p) => { await p.fill("user", "alice"); }, { begin: "already_started" });
    expect(result).toMatchObject({ status: "blocked", reason: "durable_state_changed" });
  });

  it("allows empty cleanup best-effort without durable calls and preserves a primary denial", async () => {
    const events: string[] = [];
    const result = await execute(events, async (p) => { try { await p.fill("user", "alice"); } catch { await p.fill("user", ""); } }, { begin: "stale_owner" });
    expect(events).toEqual(["begin", "fill:user:"]);
    expect(result).toMatchObject({ status: "blocked", reason: "ownership_lost" });
  });

  it("forwards read methods and the exact detection window", async () => {
    const events: string[] = [];
    const raw = page(events, { currentUrl: async () => { events.push("url"); return "url"; }, hasVisibleSelector: async (s, timeout) => { events.push(`${s}:${timeout}`); return true; } });
    let received: BankAutoLoginPage | undefined;
    const result = await executeDurablyFencedAutoLogin({ strategy: { bankCode: "popular", autoLogin: async ({ page: strategyPage }) => { received = strategyPage; return { status: "succeeded" }; } }, credential, page: raw, attempts: attempts(events), owner, leaseDurationMs: 1 });
    expect(result.status).toBe("completed");
    expect(received?.protectedStateDetectionWindowMs).toBe(raw.protectedStateDetectionWindowMs);
    await received?.currentUrl();
    await received?.hasVisibleSelector("mfa", 77);
    expect(events).toEqual(["url", "mfa:77"]);
  });

  it("fences the real strategy in begin, username, renew, password, barrier, click order", async () => {
    const events: string[] = [];
    const raw = page(events, { currentUrl: async () => events.some((event) => event === "click:submit") ? "https://bank.example/dashboard" : "https://bank.example/login", hasVisibleSelector: async (selector) => !["mfa", "incompatible"].includes(selector) });
    const real = createBankAutoLoginStrategy({ bankCode: "popular", baseUrl: "https://bank.example", loginPathAllowlist: ["/login"], usernameSelector: "user", passwordSelector: "password", submitSelector: "submit", mfaIndicatorSelector: "mfa", incompatibleFlowSelector: "incompatible", dashboardPathIndicator: "/dashboard" });
    await executeDurablyFencedAutoLogin({ strategy: real, credential, page: raw, attempts: attempts(events), owner, leaseDurationMs: 1 });
    expect(events).toEqual(["begin", "fill:user:alice", "renew", "fill:password:secret", "barrier", "click:submit"]);
  });

  it("does no durable mutation when the real guard rejects before the first fill or sees protected state before submit", async () => {
    const config = { bankCode: "popular", baseUrl: "https://bank.example", loginPathAllowlist: ["/login"], usernameSelector: "user", passwordSelector: "password", submitSelector: "submit", mfaIndicatorSelector: "mfa", incompatibleFlowSelector: "incompatible", dashboardPathIndicator: "/dashboard" };
    const guardEvents: string[] = [];
    await executeDurablyFencedAutoLogin({ strategy: createBankAutoLoginStrategy(config), credential, page: page(guardEvents, { currentUrl: async () => "https://evil.example" }), attempts: attempts(guardEvents), owner, leaseDurationMs: 1 });
    expect(guardEvents).toEqual([]);
    const protectedEvents: string[] = [];
    let protectedChecks = 0;
    await executeDurablyFencedAutoLogin({ strategy: createBankAutoLoginStrategy(config), credential, page: page(protectedEvents, { currentUrl: async () => "https://bank.example/login", hasVisibleSelector: async (selector) => selector === "mfa" ? ++protectedChecks === 3 : selector !== "incompatible" }), attempts: attempts(protectedEvents), owner, leaseDurationMs: 1 });
    expect(protectedEvents).toEqual(["begin", "fill:user:alice", "renew", "fill:password:secret", "fill:password:", "fill:user:"]);
  });

  it("requires a fresh barrier for a second click", async () => {
    const events: string[] = [];
    let barrierCalls = 0;
    const result = await executeDurablyFencedAutoLogin({ strategy: strategy(async (p) => { await p.click("one"); await p.click("two"); }), credential, page: page(events), attempts: { ...attempts(events), recordSubmitBarrier: async () => { events.push("barrier"); return { status: ++barrierCalls === 1 ? "recorded" : "already_recorded", record }; } }, owner, leaseDurationMs: 1 });
    expect(events).toEqual(["barrier", "click:one", "barrier"]);
    expect(result).toMatchObject({ status: "blocked" });
  });
});
