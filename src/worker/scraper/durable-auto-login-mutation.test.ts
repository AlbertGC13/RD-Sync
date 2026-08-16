import { describe, expect, it } from "vitest";
import { createBankAutoLoginStrategy, type BankAutoLoginPage, type BankAutoLoginOutcome, type BankAutoLoginStrategy } from "./auto-login";
import { executeDurablyFencedAutoLogin } from "./durable-auto-login-mutation";
import type { CredentialMutationFence } from "./authenticated-session-mutation-runner";

const credential = { bankCode: "popular", username: "alice", password: "secret" };
type Input = Parameters<typeof executeDurablyFencedAutoLogin>[0];
type Output = Awaited<ReturnType<typeof executeDurablyFencedAutoLogin>>;
type Has<K extends PropertyKey, T> = K extends keyof T ? true : false;
const noLooseInput: Has<"attempts" | "owner" | "leaseDurationMs", Input> extends false ? true : false = true;
const noPhaseOutput: Has<"interactionPhase" | "reason", Output> extends false ? true : false = true;
void noLooseInput;
void noPhaseOutput;

function raw(events: string[], overrides: Partial<BankAutoLoginPage> = {}): BankAutoLoginPage {
  return { currentUrl: async () => "https://bank.example/login", hasVisibleSelector: async () => false, protectedStateDetectionWindowMs: 321, fill: async (selector, value) => { events.push(`fill:${selector}:${value}`); }, click: async (selector) => { events.push(`click:${selector}`); }, ...overrides };
}
function fence(events: string[], outcomes: Partial<Record<"begin" | "renew" | "barrier", unknown>> = {}): CredentialMutationFence {
  const call = (name: "begin" | "renew" | "barrier") => async () => { events.push(name); const value = Object.hasOwn(outcomes, name) ? outcomes[name] : { status: "authorized" }; if (value === "throw") throw new Error("sensitive"); return value as { status: "authorized" | "blocked" }; };
  return { beginCredentialInteraction: call("begin"), renewBeforeCredentialMutation: call("renew"), recordSubmitBarrier: call("barrier") };
}
function strategy(run: (page: BankAutoLoginPage) => Promise<void>, outcome: BankAutoLoginOutcome = { status: "succeeded" }): BankAutoLoginStrategy {
  return { bankCode: "popular", autoLogin: async ({ page }) => { try { await run(page); return outcome; } catch { return { status: "succeeded" }; } } };
}
function execute(events: string[], run: (page: BankAutoLoginPage) => Promise<void>, outcomes = {}, page = raw(events), signal?: AbortSignal) {
  return executeDurablyFencedAutoLogin({ strategy: strategy(run), credential, page, fence: fence(events, outcomes), signal: signal ?? new AbortController().signal });
}

describe("executeDurablyFencedAutoLogin", () => {
  it("has only the fence-native API and exact result surface", async () => {
    await expect(execute([], async () => {})).resolves.toEqual({ status: "completed", outcome: { status: "succeeded" } });
  });
  it("begins before the first fill and renews immediately before every later credential fill", async () => {
    const events: string[] = [];
    await execute(events, async (page) => { await page.fill("user", "alice"); await page.fill("password", "secret"); await page.fill("otp", "x"); });
    expect(events).toEqual(["begin", "fill:user:alice", "renew", "fill:password:secret", "renew", "fill:otp:x"]);
  });
  it("fences the real strategy in the required credential and submit order", async () => {
    const events: string[] = [];
    const page = raw(events, { currentUrl: async () => events.includes("click:submit") ? "https://bank.example/dashboard" : "https://bank.example/login", hasVisibleSelector: async (selector) => !["mfa", "incompatible"].includes(selector) });
    const real = createBankAutoLoginStrategy({ bankCode: "popular", baseUrl: "https://bank.example", loginPathAllowlist: ["/login"], usernameSelector: "user", passwordSelector: "password", submitSelector: "submit", mfaIndicatorSelector: "mfa", incompatibleFlowSelector: "incompatible", dashboardPathIndicator: "/dashboard" });
    await executeDurablyFencedAutoLogin({ strategy: real, credential, page, fence: fence(events), signal: new AbortController().signal });
    expect(events).toEqual(["begin", "fill:user:alice", "renew", "fill:password:secret", "barrier", "click:submit"]);
  });
  it("allows best-effort empty cleanup without a fence and cannot clear a sticky failure", async () => {
    const events: string[] = [];
    const result = await execute(events, async (page) => { try { await page.fill("user", "alice"); } catch { await page.fill("user", ""); } try { await page.fill("later", "x"); } catch {} }, { begin: { status: "blocked" } });
    expect([events, result]).toEqual([["begin", "fill:user:"], { status: "blocked" }]);
  });
  it.each(["begin", "renew", "barrier"] as const)("accepts only an exact authorized %s response", async (method) => {
    for (const value of [{ status: "blocked" }, null, 1, {}, { status: "authorized", extra: true }, { status: "unknown" }, "throw"]) {
      const events: string[] = [];
      const run = method === "begin" ? async (page: BankAutoLoginPage) => page.fill("u", "x") : method === "renew" ? async (page: BankAutoLoginPage) => { await page.fill("u", "x"); await page.fill("p", "x"); } : async (page: BankAutoLoginPage) => page.click("submit");
      const result = await execute(events, run, { [method]: value });
      expect(result).toEqual({ status: "blocked" });
      expect(events.filter((event) => event.startsWith("fill:") || event.startsWith("click:")).length).toBe(method === "renew" ? 1 : 0);
    }
  });
  it("makes denied fences sticky despite strategy catches and rechecks every click", async () => {
    const events: string[] = [];
    const result = await execute(events, async (page) => { try { await page.click("one"); } catch {} await page.click("two"); }, { barrier: { status: "blocked" } });
    expect([events, result]).toEqual([["barrier"], { status: "blocked" }]);
  });
  it("marks caught raw fill or click failures sticky so they cannot produce success", async () => {
    for (const mutation of ["fill", "click"] as const) {
      const events: string[] = [];
      const page = raw(events, mutation === "fill" ? { fill: async () => { events.push("fill"); throw new Error("secret"); } } : { click: async () => { events.push("click"); throw new Error("secret"); } });
      const result = await execute(events, async (wrapped) => { try { if (mutation === "fill") await wrapped.fill("u", "x"); else await wrapped.click("go"); } catch {} }, {}, page);
      expect(result).toEqual({ status: "blocked" });
    }
  });
  it("blocks pre-aborted and during-strategy cancellation even when the strategy returns success", async () => {
    const pre = new AbortController(); pre.abort();
    await expect(execute([], async (page) => { try { await page.fill("u", "x"); } catch {} }, {}, raw([]), pre.signal)).resolves.toEqual({ status: "blocked" });
    const during = new AbortController(); const events: string[] = [];
    await expect(execute(events, async (page) => { during.abort(); try { await page.fill("u", "x"); } catch {} }, {}, raw(events), during.signal)).resolves.toEqual({ status: "blocked" });
    expect(events).toEqual([]);
  });
  it("places a fresh barrier immediately before every raw click", async () => {
    const events: string[] = [];
    await execute(events, async (page) => { await page.click("one"); await page.click("two"); });
    expect(events).toEqual(["barrier", "click:one", "barrier", "click:two"]);
  });
  it("forwards read methods and the exact detection-window property", async () => {
    const events: string[] = []; const page = raw(events, { currentUrl: async () => { events.push("url"); return "url"; }, hasVisibleSelector: async (selector, timeout) => { events.push(`${selector}:${timeout}`); return true; } }); let received: BankAutoLoginPage | undefined;
    await executeDurablyFencedAutoLogin({ strategy: { bankCode: "popular", autoLogin: async ({ page }) => { received = page; return { status: "succeeded" }; } }, credential, page, fence: fence(events), signal: new AbortController().signal });
    await received?.currentUrl(); await received?.hasVisibleSelector("mfa", 77);
    expect([received?.protectedStateDetectionWindowMs, events]).toEqual([321, ["url", "mfa:77"]]);
  });
});
