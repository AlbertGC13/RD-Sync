import { describe, expect, it, vi } from "vitest";
import { encryptCredentialField } from "../../modules/bank-credentials/crypto";
import type { BankAutoLoginOutcome } from "./auto-login";
import { createScrapeTimeAutoLoginAuthenticationExecution, type FencedScrapeTimeAutoLoginRunnerDependencies } from "./scrape-time-auto-login-authentication-execution";

const key = Buffer.alloc(32, 7);
const identity = { bankCode: "popular", runId: "run", attemptId: "attempt" };
const job = { data: { bankId: "popular", runId: "run" } };
const page = { currentUrl: async () => "https://bank/login", hasVisibleSelector: async () => false, fill: vi.fn(), click: vi.fn() };
const base = (outcome: unknown = { status: "succeeded" }): FencedScrapeTimeAutoLoginRunnerDependencies => ({
  adapterRegistry: {
    get: vi.fn(() => ({
      bankCode: "popular",
      createAutoLoginStrategy: () => ({
        bankCode: "popular",
        autoLogin: vi.fn(async ({ page: durablePage }) => {
          await durablePage.fill("u", "user");
          await durablePage.click("s");
          return outcome as BankAutoLoginOutcome;
        }),
      }),
    })),
  },
  autoLoginConfigs: { getByBankCode: vi.fn().mockResolvedValue({ autoLoginEnabled: true, breakerState: "closed" }) },
  credentials: { findByBankCode: vi.fn().mockResolvedValue({ bankCode: "popular", isActive: true, keyVersion: 1, encryptedUsernameEnvelope: JSON.stringify(encryptCredentialField("user", () => key)), encryptedPasswordEnvelope: JSON.stringify(encryptCredentialField("pass", () => key)) }) },
  keyResolver: () => key, lock: { acquire: vi.fn().mockResolvedValue({ leaseToken: "l", fencingToken: 1, expiresAt: 1 }), release: vi.fn().mockResolvedValue(true) }, cdpUrlForBankCode: () => "http://127.0.0.1:9222", ensureBrowser: vi.fn().mockResolvedValue({ status: "ready", page, close: vi.fn() }),
});
const fence = () => ({ beginCredentialInteraction: vi.fn().mockResolvedValue({ status: "authorized" as const }), renewBeforeCredentialMutation: vi.fn().mockResolvedValue({ status: "authorized" as const }), recordSubmitBarrier: vi.fn().mockResolvedValue({ status: "authorized" as const }) });
const execute = (dependencies = base(), controller = new AbortController()) => createScrapeTimeAutoLoginAuthenticationExecution({ runnerDependencies: dependencies, job, identity }).execute({ fence: fence(), signal: controller.signal });

describe("createScrapeTimeAutoLoginAuthenticationExecution", () => {
  it("validates immutable exact identity and rejects expiry fields", () => {
    expect(() => createScrapeTimeAutoLoginAuthenticationExecution({ runnerDependencies: base(), job: { data: { ...job.data, expiredEventId: undefined } }, identity })).toThrow("Invalid authentication execution input");
    expect(() => createScrapeTimeAutoLoginAuthenticationExecution({ runnerDependencies: base(), job, identity: { ...identity, bankCode: "other" } })).toThrow("Invalid authentication execution input");
    expect(() => createScrapeTimeAutoLoginAuthenticationExecution({ runnerDependencies: base(), job, identity: { bankCode: "popular", runId: "run", attemptId: "" } })).toThrow("Invalid authentication execution input");
  });

  it("rejects legacy hook descriptors without evaluating accessors", () => {
    let reads = 0; const dependencies = Object.create({ get beforeAutoLoginMutation() { reads++; return undefined; } }) as ReturnType<typeof base>;
    expect(() => createScrapeTimeAutoLoginAuthenticationExecution({ runnerDependencies: dependencies, job, identity })).toThrow("Invalid authentication execution input");
    expect(reads).toBe(0);
  });

  it.each([
    [{ status: "succeeded" }, { status: "succeeded" }],
    [{ status: "needs_admin_action", reason: "protected_flow", safeSummary: "secret" }, { status: "rejected", cause: "protected_or_mfa" }],
    [{ status: "needs_admin_action", reason: "incompatible_flow", safeSummary: "secret" }, { status: "rejected", cause: "incompatible_flow" }],
    [{ status: "needs_admin_action", reason: "browser_unavailable", safeSummary: "secret" }, { status: "transient_unavailable" }],
    [{ status: "needs_admin_action", reason: "unknown_post_submit_state", safeSummary: "secret" }, { status: "rejected", cause: "unknown" }],
    [{ status: "throttled", safeSummary: "secret" }, { status: "transient_unavailable" }],
    [{ status: "skipped", reason: "disabled", safeSummary: "secret" }, { status: "rejected", cause: "structural_configuration" }],
  ])("maps safe runner outcomes without retaining summaries", async (outcome, expected) => {
    const result = await execute(base(outcome));
    expect(result).toEqual(expected);
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("is single use, pre-abort is inert, and malformed output blocks", async () => {
    const controller = new AbortController(); controller.abort(); const dependencies = base();
    await expect(execute(dependencies, controller)).resolves.toEqual({ status: "cancelled" });
    expect(dependencies.adapterRegistry.get).not.toHaveBeenCalled();
    const execution = createScrapeTimeAutoLoginAuthenticationExecution({ runnerDependencies: base(null), job, identity });
    await expect(execution.execute({ fence: fence(), signal: new AbortController().signal })).resolves.toEqual({ status: "blocked" });
    await expect(execution.execute({ fence: fence(), signal: new AbortController().signal })).resolves.toEqual({ status: "blocked" });
  });
});
