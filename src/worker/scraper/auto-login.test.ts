import { describe, expect, it, vi } from "vitest";

import { encryptCredentialField } from "../../modules/bank-credentials/crypto";
import { createBankAutoLoginStrategy, createScrapeTimeAutoLoginRunner, executeScrapeTimeAutoLoginTrigger, unavailableScrapeTimeAutoLoginBrowserOpener, type BankAutoLoginPage } from "./auto-login";
import type { BankPortalConfig } from "./login-mutation-guard";

const portalConfig: BankPortalConfig = {
  bankCode: "popular",
  baseUrl: "https://ib.bpd.com.do",
  loginPathAllowlist: ["/login"],
  usernameSelector: "#username",
  passwordSelector: "#password",
  submitSelector: "button[type='submit']",
  mfaIndicatorSelector: "[data-mfa]",
  incompatibleFlowSelector: "[data-token]",
  dashboardPathIndicator: "/dashboard",
};

const loginControls = [portalConfig.usernameSelector, portalConfig.passwordSelector, portalConfig.submitSelector] as const;
const credential = { bankCode: "popular", username: "bank-user", password: "bank-password" };
type TestBankAutoLoginPage = BankAutoLoginPage & { setUrl(nextUrl: string): void; show(selector: string): void };

function makePage(options: { url?: string; visible?: readonly string[]; onFill?: (selector: string, value: string) => void; onClick?: () => void } = {}): TestBankAutoLoginPage {
  let url = options.url ?? "https://ib.bpd.com.do/login";
  const visible = new Set(options.visible ?? loginControls);
  return {
    async currentUrl() { return url; },
    async hasVisibleSelector(selector) { return visible.has(selector); },
    async fill(selector, value) { options.onFill?.(selector, value); },
    async click() {
      if (options.onClick) options.onClick();
      else url = "https://ib.bpd.com.do/dashboard";
    },
    setUrl(nextUrl: string) { url = nextUrl; },
    show(selector: string) { visible.add(selector); },
  };
}

describe("createBankAutoLoginStrategy", () => {
  it("fills and submits only after the guard authorizes both boundaries", async () => {
    const fill = vi.fn();
    const page = makePage({ onFill: fill });
    const click = vi.spyOn(page, "click");
    const strategy = createBankAutoLoginStrategy(portalConfig, { supportedBankCodes: ["popular"] });

    await expect(strategy.autoLogin({ credential, page })).resolves.toEqual({ status: "succeeded" });
    expect(fill.mock.calls).toEqual([["#username", "bank-user"], ["#password", "bank-password"]]);
    expect(click).toHaveBeenCalledWith("button[type='submit']");
  });

  it("fails closed for an unsupported explicit bank without filling credentials", async () => {
    const fill = vi.fn();
    const click = vi.fn();
    const strategy = createBankAutoLoginStrategy({ ...portalConfig, bankCode: "unknown-bank" }, { supportedBankCodes: ["popular"] });

    await expect(strategy.autoLogin({ credential: { ...credential, bankCode: "unknown-bank" }, page: makePage({ onFill: fill, onClick: click }) })).resolves.toMatchObject({
      status: "needs_admin_action",
      reason: "unsupported_bank",
    });
    expect(fill).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
  });

  it("fails closed for a credential-bank mismatch without filling credentials", async () => {
    const fill = vi.fn();
    const click = vi.fn();
    const strategy = createBankAutoLoginStrategy(portalConfig);

    await expect(strategy.autoLogin({ credential: { ...credential, bankCode: "bhd" }, page: makePage({ onFill: fill, onClick: click }) })).resolves.toMatchObject({
      status: "needs_admin_action",
      reason: "credential_bank_mismatch",
    });
    expect(fill).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
  });

  it("returns safe admin-action outcomes and never submits when pre-submit state is unsafe", async () => {
    const cases = [
      { visible: [portalConfig.incompatibleFlowSelector, ...loginControls], reason: "incompatible_flow" },
      { visible: [portalConfig.mfaIndicatorSelector, ...loginControls], reason: "protected_flow" },
      { visible: [portalConfig.usernameSelector, portalConfig.submitSelector], reason: "missing_required_login_control" },
    ] as const;
    const strategy = createBankAutoLoginStrategy(portalConfig);

    for (const unsafeCase of cases) {
      const fill = vi.fn();
      const click = vi.fn();
      const result = await strategy.autoLogin({ credential, page: makePage({ visible: unsafeCase.visible, onFill: fill, onClick: click }) });

      expect(result).toMatchObject({ status: "needs_admin_action", reason: unsafeCase.reason });
      expect(fill).not.toHaveBeenCalled();
      expect(click).not.toHaveBeenCalled();
    }
  });

  it("re-checks the guard before password fill so redirects cannot receive passwords", async () => {
    let setPageUrl: (nextUrl: string) => void = () => undefined;
    const fill = vi.fn((selector: string) => {
      if (selector === portalConfig.usernameSelector) setPageUrl("https://evil.example/login");
    });
    const page = makePage({ onFill: fill });
    setPageUrl = page.setUrl;
    const click = vi.spyOn(page, "click");

    await expect(createBankAutoLoginStrategy(portalConfig).autoLogin({ credential, page })).resolves.toMatchObject({
      status: "needs_admin_action",
      reason: "unauthorized_login_page",
    });
    expect(fill.mock.calls).toEqual([["#username", "bank-user"]]);
    expect(click).not.toHaveBeenCalled();
  });

  it("re-checks the guard before submit so redirects after password fill cannot submit credentials", async () => {
    let setPageUrl: (nextUrl: string) => void = () => undefined;
    const fill = vi.fn((selector: string) => {
      if (selector === portalConfig.passwordSelector) setPageUrl("https://evil.example/login");
    });
    const page = makePage({ onFill: fill });
    setPageUrl = page.setUrl;
    const click = vi.spyOn(page, "click");

    await expect(createBankAutoLoginStrategy(portalConfig).autoLogin({ credential, page })).resolves.toMatchObject({
      status: "needs_admin_action",
      reason: "unauthorized_login_page",
    });
    expect(fill.mock.calls).toEqual([["#username", "bank-user"], ["#password", "bank-password"]]);
    expect(click).not.toHaveBeenCalled();
  });

  it("does not treat external or non-HTTPS dashboard redirects as success", async () => {
    const cases = ["https://evil.example/dashboard", "http://ib.bpd.com.do/dashboard", "https://user@ib.bpd.com.do/dashboard"];

    for (const redirectedUrl of cases) {
      const page = makePage({ onClick: () => page.setUrl(redirectedUrl) });

      await expect(createBankAutoLoginStrategy(portalConfig).autoLogin({ credential, page })).resolves.toMatchObject({
        status: "needs_admin_action",
        reason: "unknown_post_submit_state",
      });
    }
  });

  it("does not treat dashboard path prefix collisions as success", async () => {
    const page = makePage({ onClick: () => page.setUrl("https://ib.bpd.com.do/dashboardevil") });

    await expect(createBankAutoLoginStrategy(portalConfig).autoLogin({ credential, page })).resolves.toMatchObject({
      status: "needs_admin_action",
      reason: "unknown_post_submit_state",
    });
  });

  it("treats dashboard subpaths as success", async () => {
    const page = makePage({ onClick: () => page.setUrl("https://ib.bpd.com.do/dashboard/accounts") });

    await expect(createBankAutoLoginStrategy(portalConfig).autoLogin({ credential, page })).resolves.toEqual({ status: "succeeded" });
  });

  it("maps malformed portal config and browser mutation failures to safe admin action", async () => {
    await expect(createBankAutoLoginStrategy({ ...portalConfig, baseUrl: "not-a-url" }).autoLogin({ credential, page: makePage() })).resolves.toMatchObject({
      status: "needs_admin_action",
      reason: "malformed_url",
    });

    const fillFailurePage = makePage();
    vi.spyOn(fillFailurePage, "fill").mockRejectedValueOnce(new Error("browser fill failed"));
    await expect(createBankAutoLoginStrategy(portalConfig).autoLogin({ credential, page: fillFailurePage })).resolves.toMatchObject({
      status: "needs_admin_action",
      reason: "portal_state_unavailable",
    });

    const clickFailurePage = makePage();
    vi.spyOn(clickFailurePage, "click").mockRejectedValueOnce(new Error("browser click failed"));
    await expect(createBankAutoLoginStrategy(portalConfig).autoLogin({ credential, page: clickFailurePage })).resolves.toMatchObject({
      status: "needs_admin_action",
      reason: "portal_state_unavailable",
    });
  });

  it("maps post-submit protected and unknown portal states to safe admin action", async () => {
    const mfaPage = makePage({ onClick: () => mfaPage.show(portalConfig.mfaIndicatorSelector) });
    const unknownPage = makePage({ onClick: () => unknownPage.setUrl("https://ib.bpd.com.do/unexpected") });
    const strategy = createBankAutoLoginStrategy(portalConfig);

    await expect(strategy.autoLogin({ credential, page: mfaPage })).resolves.toMatchObject({ status: "needs_admin_action", reason: "protected_flow" });
    await expect(strategy.autoLogin({ credential, page: unknownPage })).resolves.toMatchObject({ status: "needs_admin_action", reason: "unknown_post_submit_state" });
  });
});

describe("executeScrapeTimeAutoLoginTrigger", () => {
  it("acquires the expired-event lock, runs browser login, and awaits owner release after success", async () => {
    const page = makePage();
    const events: string[] = [];
    let releaseStartedResolve: () => void = () => undefined;
    let releaseSettledResolve: (value: boolean) => void = () => undefined;
    const releaseStarted = new Promise<void>((resolve) => { releaseStartedResolve = resolve; });
    const releaseSettled = new Promise<boolean>((resolve) => { releaseSettledResolve = resolve; });
    const acquire = vi.fn().mockResolvedValue({ leaseToken: "lease-1", fencingToken: 7, expiresAt: 12345 });
    const release = vi.fn(() => {
      events.push("release started");
      releaseStartedResolve();
      return releaseSettled;
    });
    const autoLogin = vi.fn(() => Promise.resolve({ status: "succeeded" as const }).then((outcome) => {
      events.push("autoLogin settled");
      return outcome;
    }));
    const ensureBrowser = vi.fn(() => Promise.resolve({ status: "ready" as const, page }).then((browser) => {
      events.push("ensureBrowser settled");
      return browser;
    }));

    let helperResolved = false;
    const result = executeScrapeTimeAutoLoginTrigger({
      bankCode: "popular",
      expiredEventId: "E1",
      adapter: { bankCode: "popular", createAutoLoginStrategy: () => ({ bankCode: "popular", autoLogin }) },
      credential,
      cdpUrl: "http://127.0.0.1:9222",
      lock: { acquire, release },
      ensureBrowser,
    }).then((outcome) => {
      helperResolved = true;
      events.push("helper resolved");
      return outcome;
    });

    await releaseStarted;
    await Promise.resolve();
    expect(helperResolved).toBe(false);
    expect(events).toEqual(["ensureBrowser settled", "autoLogin settled", "release started"]);

    releaseSettledResolve(true);
    await expect(result).resolves.toEqual({ status: "succeeded" });

    expect(acquire).toHaveBeenCalledWith("popular", "E1");
    expect(ensureBrowser).toHaveBeenCalledWith("http://127.0.0.1:9222");
    expect(autoLogin).toHaveBeenCalledWith({ credential, page });
    expect(release).toHaveBeenCalledWith("popular", "E1", "lease-1");
    expect(events).toEqual(["ensureBrowser settled", "autoLogin settled", "release started", "helper resolved"]);
  });

  it("requires manual scraping when the same expired event lock is already held", async () => {
    const acquire = vi.fn().mockResolvedValue(null);
    const ensureBrowser = vi.fn();
    const release = vi.fn();

    await expect(executeScrapeTimeAutoLoginTrigger({
      bankCode: "popular",
      expiredEventId: "E1",
      adapter: { bankCode: "popular", createAutoLoginStrategy: () => createBankAutoLoginStrategy(portalConfig) },
      credential,
      cdpUrl: "http://127.0.0.1:9222",
      lock: { acquire, release },
      ensureBrowser,
    })).resolves.toEqual({
      status: "manual_required",
      reason: "lock_busy",
      safeSummary: "Manual scrape required before retrying bank auto-login",
    });

    expect(ensureBrowser).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it("requires manual scraping without leaking raw errors when lock acquire fails", async () => {
    const acquire = vi.fn().mockRejectedValue(new Error("redis token=secret unavailable"));
    const ensureBrowser = vi.fn();
    const release = vi.fn();

    await expect(executeScrapeTimeAutoLoginTrigger({
      bankCode: "popular",
      expiredEventId: "E1",
      adapter: { bankCode: "popular", createAutoLoginStrategy: () => createBankAutoLoginStrategy(portalConfig) },
      credential,
      cdpUrl: "http://127.0.0.1:9222",
      lock: { acquire, release },
      ensureBrowser,
    })).resolves.toEqual({
      status: "manual_required",
      reason: "lock_unavailable",
      safeSummary: "Manual scrape required before retrying bank auto-login",
    });

    expect(ensureBrowser).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it("fails closed before credential use on adapter mismatch or unsafe CDP URL", async () => {
    const createAutoLoginStrategy = vi.fn();
    const acquire = vi.fn();
    const release = vi.fn();
    const base = {
      bankCode: "popular",
      expiredEventId: "E1",
      credential: { ...credential, bankCode: "bhd" },
      lock: { acquire, release },
      ensureBrowser: vi.fn(),
    };

    await expect(executeScrapeTimeAutoLoginTrigger({
      ...base,
      adapter: { bankCode: "popular", createAutoLoginStrategy },
      cdpUrl: "http://127.0.0.1:9222",
    })).resolves.toMatchObject({ status: "needs_admin_action", reason: "credential_bank_mismatch" });

    await expect(executeScrapeTimeAutoLoginTrigger({
      ...base,
      credential,
      adapter: { bankCode: "popular", createAutoLoginStrategy },
      cdpUrl: "http://10.0.0.5:9222",
    })).resolves.toMatchObject({ status: "needs_admin_action", reason: "browser_unavailable" });

    expect(createAutoLoginStrategy).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
  });

  it("fails closed on adapter/context bank mismatch before lock, browser, or credential use", async () => {
    const createAutoLoginStrategy = vi.fn();
    const acquire = vi.fn();
    const release = vi.fn();
    const ensureBrowser = vi.fn();

    await expect(executeScrapeTimeAutoLoginTrigger({
      bankCode: "bhd",
      expiredEventId: "E1",
      adapter: { bankCode: "popular", createAutoLoginStrategy },
      credential,
      cdpUrl: "http://127.0.0.1:9222",
      lock: { acquire, release },
      ensureBrowser,
    })).resolves.toMatchObject({ status: "needs_admin_action", reason: "unsupported_bank" });

    expect(createAutoLoginStrategy).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
    expect(ensureBrowser).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it("owner-releases the lock when browser capacity is throttled", async () => {
    const acquire = vi.fn().mockResolvedValue({ leaseToken: "lease-1", fencingToken: 7, expiresAt: 12345 });
    const release = vi.fn().mockResolvedValue(true);
    const autoLogin = vi.fn();

    await expect(executeScrapeTimeAutoLoginTrigger({
      bankCode: "popular",
      expiredEventId: "E1",
      adapter: { bankCode: "popular", createAutoLoginStrategy: () => ({ bankCode: "popular", autoLogin }) },
      credential,
      cdpUrl: "http://127.0.0.1:9222",
      lock: { acquire, release },
      ensureBrowser: vi.fn().mockResolvedValue({ status: "throttled" }),
    })).resolves.toEqual({ status: "throttled", safeSummary: "Bank browser capacity is temporarily unavailable" });

    expect(autoLogin).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith("popular", "E1", "lease-1");
  });

  it("owner-releases the lock when browser startup fails without leaking raw errors", async () => {
    const release = vi.fn().mockResolvedValue(true);

    await expect(executeScrapeTimeAutoLoginTrigger({
      bankCode: "popular",
      expiredEventId: "E1",
      adapter: { bankCode: "popular", createAutoLoginStrategy: () => ({ bankCode: "popular", autoLogin: vi.fn() }) },
      credential,
      cdpUrl: "http://127.0.0.1:9222",
      lock: { acquire: vi.fn().mockResolvedValue({ leaseToken: "lease-1", fencingToken: 7, expiresAt: 12345 }), release },
      ensureBrowser: vi.fn().mockRejectedValue(new Error("cdp token=secret refused")),
    })).resolves.toEqual({
      status: "needs_admin_action",
      reason: "browser_unavailable",
      safeSummary: "Bank auto-login requires admin action",
    });

    expect(release).toHaveBeenCalledWith("popular", "E1", "lease-1");
  });

  it("owner-releases the lock when delegated login returns admin action", async () => {
    const release = vi.fn().mockResolvedValue(true);
    const autoLogin = vi.fn().mockResolvedValue({
      status: "needs_admin_action",
      reason: "protected_flow",
      safeSummary: "MFA is required",
    });

    await expect(executeScrapeTimeAutoLoginTrigger({
      bankCode: "popular",
      expiredEventId: "E1",
      adapter: { bankCode: "popular", createAutoLoginStrategy: () => ({ bankCode: "popular", autoLogin }) },
      credential,
      cdpUrl: "http://127.0.0.1:9222",
      lock: { acquire: vi.fn().mockResolvedValue({ leaseToken: "lease-1", fencingToken: 7, expiresAt: 12345 }), release },
      ensureBrowser: vi.fn().mockResolvedValue({ status: "ready", page: makePage() }),
    })).resolves.toEqual({
      status: "needs_admin_action",
      reason: "protected_flow",
      safeSummary: "MFA is required",
    });

    expect(release).toHaveBeenCalledWith("popular", "E1", "lease-1");
  });

  it("owner-releases the lock and reports portal state unavailable when delegated login rejects", async () => {
    const release = vi.fn().mockResolvedValue(true);
    const autoLogin = vi.fn().mockRejectedValue(new Error("portal token=secret crashed"));

    await expect(executeScrapeTimeAutoLoginTrigger({
      bankCode: "popular",
      expiredEventId: "E1",
      adapter: { bankCode: "popular", createAutoLoginStrategy: () => ({ bankCode: "popular", autoLogin }) },
      credential,
      cdpUrl: "http://127.0.0.1:9222",
      lock: { acquire: vi.fn().mockResolvedValue({ leaseToken: "lease-1", fencingToken: 7, expiresAt: 12345 }), release },
      ensureBrowser: vi.fn().mockResolvedValue({ status: "ready", page: makePage() }),
    })).resolves.toEqual({
      status: "needs_admin_action",
      reason: "portal_state_unavailable",
      safeSummary: "Bank auto-login requires admin action",
    });

    expect(release).toHaveBeenCalledWith("popular", "E1", "lease-1");
  });

  it("records safe release failure metadata without changing a successful outcome", async () => {
    const release = vi.fn().mockRejectedValue(new Error("Redis token=secret failed"));
    const recordLockReleaseFailure = vi.fn().mockResolvedValue(undefined);

    await expect(executeScrapeTimeAutoLoginTrigger({
      bankCode: "popular",
      expiredEventId: "E1",
      adapter: { bankCode: "popular", createAutoLoginStrategy: () => ({ bankCode: "popular", autoLogin: vi.fn().mockResolvedValue({ status: "succeeded" }) }) },
      credential,
      cdpUrl: "http://127.0.0.1:9222",
      lock: { acquire: vi.fn().mockResolvedValue({ leaseToken: "lease-1", fencingToken: 7, expiresAt: 12345 }), release },
      ensureBrowser: vi.fn().mockResolvedValue({ status: "ready", page: makePage() }),
      recordLockReleaseFailure,
    })).resolves.toEqual({ status: "succeeded" });

    expect(recordLockReleaseFailure.mock.calls).toEqual([[{ bankCode: "popular", expiredEventId: "E1" }]]);
  });

  it("records safe release failure metadata when release resolves false", async () => {
    const release = vi.fn().mockResolvedValue(false);
    const recordLockReleaseFailure = vi.fn().mockResolvedValue(undefined);

    await expect(executeScrapeTimeAutoLoginTrigger({
      bankCode: "popular",
      expiredEventId: "E1",
      adapter: { bankCode: "popular", createAutoLoginStrategy: () => ({ bankCode: "popular", autoLogin: vi.fn().mockResolvedValue({ status: "succeeded" }) }) },
      credential,
      cdpUrl: "http://127.0.0.1:9222",
      lock: { acquire: vi.fn().mockResolvedValue({ leaseToken: "lease-1", fencingToken: 7, expiresAt: 12345 }), release },
      ensureBrowser: vi.fn().mockResolvedValue({ status: "ready", page: makePage() }),
      recordLockReleaseFailure,
    })).resolves.toEqual({ status: "succeeded" });

    expect(recordLockReleaseFailure.mock.calls).toEqual([[{ bankCode: "popular", expiredEventId: "E1" }]]);
  });

  it("swallows release failure hook rejections without changing admin outcomes", async () => {
    const release = vi.fn().mockRejectedValue(new Error("Redis token=secret failed"));
    const recordLockReleaseFailure = vi.fn().mockRejectedValue(new Error("metrics token=secret failed"));

    await expect(executeScrapeTimeAutoLoginTrigger({
      bankCode: "popular",
      expiredEventId: "E1",
      adapter: { bankCode: "popular", createAutoLoginStrategy: () => ({ bankCode: "popular", autoLogin: vi.fn().mockResolvedValue({ status: "needs_admin_action", reason: "protected_flow", safeSummary: "MFA is required" }) }) },
      credential,
      cdpUrl: "http://127.0.0.1:9222",
      lock: { acquire: vi.fn().mockResolvedValue({ leaseToken: "lease-1", fencingToken: 7, expiresAt: 12345 }), release },
      ensureBrowser: vi.fn().mockResolvedValue({ status: "ready", page: makePage() }),
      recordLockReleaseFailure,
    })).resolves.toEqual({ status: "needs_admin_action", reason: "protected_flow", safeSummary: "MFA is required" });

    expect(recordLockReleaseFailure.mock.calls).toEqual([[{ bankCode: "popular", expiredEventId: "E1" }]]);
  });
});

describe("createScrapeTimeAutoLoginRunner", () => {
  const key = Buffer.alloc(32, 7);
  const keyResolver = () => key;

  function encryptedCredentialRecord(bankCode = "popular") {
    return {
      bankCode,
      isActive: true,
      keyVersion: 1,
      encryptedUsernameEnvelope: JSON.stringify(encryptCredentialField("bank-user", keyResolver)),
      encryptedPasswordEnvelope: JSON.stringify(encryptCredentialField("bank-password", keyResolver)),
    };
  }

  it("fails closed for an explicit unknown bank without falling back to Popular", async () => {
    const findByBankCode = vi.fn();
    const run = createScrapeTimeAutoLoginRunner({
      adapterRegistry: { get: vi.fn().mockReturnValue(undefined) },
      autoLoginConfigs: { getByBankCode: vi.fn() },
      credentials: { findByBankCode },
      keyResolver,
      lock: { acquire: vi.fn(), release: vi.fn() },
      cdpUrlForBankCode: vi.fn(),
      ensureBrowser: vi.fn(),
    });
    await expect(run({ data: { bankId: "bhd", expiredEventId: "E1" } })).resolves.toMatchObject({
      status: "needs_admin_action",
      reason: "unsupported_bank",
    });
    expect(findByBankCode).not.toHaveBeenCalled();
  });

  it("skips auto-login safely when the per-bank kill switch is off", async () => {
    const findByBankCode = vi.fn();
    const acquire = vi.fn();
    const run = createScrapeTimeAutoLoginRunner({
      adapterRegistry: { get: vi.fn().mockReturnValue({ bankCode: "popular", createAutoLoginStrategy: vi.fn() }) },
      autoLoginConfigs: { getByBankCode: vi.fn().mockResolvedValue({ autoLoginEnabled: false, breakerState: "closed" }) },
      credentials: { findByBankCode },
      keyResolver,
      lock: { acquire, release: vi.fn() },
      cdpUrlForBankCode: vi.fn(),
      ensureBrowser: vi.fn(),
    });
    await expect(run({ data: { bankId: "popular", expiredEventId: "E1" } })).resolves.toBeNull();
    expect(findByBankCode).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
  });

  it("fails closed when the stored credential belongs to a different bank", async () => {
    const acquire = vi.fn();
    const ensureBrowser = vi.fn();
    const run = createScrapeTimeAutoLoginRunner({
      adapterRegistry: { get: vi.fn().mockReturnValue({ bankCode: "popular", createAutoLoginStrategy: vi.fn() }) },
      autoLoginConfigs: { getByBankCode: vi.fn().mockResolvedValue({ autoLoginEnabled: true, breakerState: "closed" }) },
      credentials: { findByBankCode: vi.fn().mockResolvedValue(encryptedCredentialRecord("bhd")) },
      keyResolver,
      lock: { acquire, release: vi.fn() },
      cdpUrlForBankCode: vi.fn().mockReturnValue("http://127.0.0.1:9222"),
      ensureBrowser,
    });

    await expect(run({ data: { bankId: "popular", expiredEventId: "E1" } })).resolves.toMatchObject({
      status: "needs_admin_action",
      reason: "credential_bank_mismatch",
    });
    expect(acquire).not.toHaveBeenCalled();
    expect(ensureBrowser).not.toHaveBeenCalled();
  });

  it("maps expected config and credential dependency failures to safe admin action outcomes", async () => {
    const baseDeps = {
      adapterRegistry: { get: vi.fn().mockReturnValue({ bankCode: "popular", createAutoLoginStrategy: vi.fn() }) },
      keyResolver,
      lock: { acquire: vi.fn(), release: vi.fn() },
      cdpUrlForBankCode: vi.fn().mockReturnValue("http://127.0.0.1:9222"),
      ensureBrowser: vi.fn(),
    };

    await expect(createScrapeTimeAutoLoginRunner({
      ...baseDeps,
      autoLoginConfigs: { getByBankCode: vi.fn().mockRejectedValue(new Error("database host internal failed")) },
      credentials: { findByBankCode: vi.fn() },
    })({ data: { bankId: "popular", expiredEventId: "E1" } })).resolves.toMatchObject({
      status: "needs_admin_action",
      reason: "auto_login_config_unavailable",
    });

    await expect(createScrapeTimeAutoLoginRunner({
      ...baseDeps,
      autoLoginConfigs: { getByBankCode: vi.fn().mockResolvedValue({ autoLoginEnabled: true, breakerState: "closed" }) },
      credentials: { findByBankCode: vi.fn().mockRejectedValue(new Error("vault token=secret failed")) },
    })({ data: { bankId: "popular", expiredEventId: "E1" } })).resolves.toMatchObject({
      status: "needs_admin_action",
      reason: "credential_unavailable",
    });
    expect(baseDeps.lock.acquire).not.toHaveBeenCalled();
  });

  it("uses the production default unavailable browser opener as a safe terminal admin action", async () => {
    const release = vi.fn().mockResolvedValue(true);
    const run = createScrapeTimeAutoLoginRunner({
      adapterRegistry: { get: vi.fn().mockReturnValue({ bankCode: "popular", createAutoLoginStrategy: vi.fn() }) },
      autoLoginConfigs: { getByBankCode: vi.fn().mockResolvedValue({ autoLoginEnabled: true, breakerState: "closed" }) },
      credentials: { findByBankCode: vi.fn().mockResolvedValue(encryptedCredentialRecord()) },
      keyResolver,
      lock: { acquire: vi.fn().mockResolvedValue({ leaseToken: "lease-1", fencingToken: 1, expiresAt: 123 }), release },
      cdpUrlForBankCode: vi.fn().mockReturnValue("http://127.0.0.1:9222"),
      ensureBrowser: unavailableScrapeTimeAutoLoginBrowserOpener,
    });

    await expect(run({ data: { bankId: "popular", expiredEventId: "E1" } })).resolves.toEqual({
      status: "needs_admin_action",
      reason: "browser_unavailable",
      safeSummary: "Bank auto-login requires admin action",
    });
    expect(release).toHaveBeenCalledWith("popular", "E1", "lease-1");
  });

  it("passes safe lock-release failure metadata through the runner dependency seam", async () => {
    const recordLockReleaseFailure = vi.fn();
    const run = createScrapeTimeAutoLoginRunner({
      adapterRegistry: { get: vi.fn().mockReturnValue({ bankCode: "popular", createAutoLoginStrategy: () => ({ bankCode: "popular", autoLogin: vi.fn().mockResolvedValue({ status: "succeeded" }) }) }) },
      autoLoginConfigs: { getByBankCode: vi.fn().mockResolvedValue({ autoLoginEnabled: true, breakerState: "closed" }) },
      credentials: { findByBankCode: vi.fn().mockResolvedValue(encryptedCredentialRecord()) },
      keyResolver,
      lock: { acquire: vi.fn().mockResolvedValue({ leaseToken: "lease-1", fencingToken: 1, expiresAt: 123 }), release: vi.fn().mockResolvedValue(false) },
      cdpUrlForBankCode: vi.fn().mockReturnValue("http://127.0.0.1:9222"),
      ensureBrowser: vi.fn().mockResolvedValue({ status: "ready", page: makePage() }),
      recordLockReleaseFailure,
    });

    await expect(run({ data: { bankId: "popular", expiredEventId: "E1" } })).resolves.toEqual({ status: "succeeded" });
    expect(recordLockReleaseFailure).toHaveBeenCalledWith({ bankCode: "popular", expiredEventId: "E1" });
  });

  it("decrypts active credentials in memory and delegates enabled runs to the scrape-time trigger", async () => {
    const page = makePage();
    const autoLogin = vi.fn().mockResolvedValue({ status: "succeeded" });
    const adapter = { bankCode: "popular", createAutoLoginStrategy: () => ({ bankCode: "popular", autoLogin }) };
    const acquire = vi.fn().mockResolvedValue({ leaseToken: "lease-1", fencingToken: 1, expiresAt: 123 });
    const release = vi.fn().mockResolvedValue(true);
    const run = createScrapeTimeAutoLoginRunner({
      adapterRegistry: { get: vi.fn().mockReturnValue(adapter) },
      autoLoginConfigs: { getByBankCode: vi.fn().mockResolvedValue({ autoLoginEnabled: true, breakerState: "closed" }) },
      credentials: { findByBankCode: vi.fn().mockResolvedValue(encryptedCredentialRecord()) },
      keyResolver,
      lock: { acquire, release },
      cdpUrlForBankCode: vi.fn().mockReturnValue("http://127.0.0.1:9222"),
      ensureBrowser: vi.fn().mockResolvedValue({ status: "ready", page }),
    });

    await expect(run({ data: { bankId: "popular", expiredEventId: "E1" } })).resolves.toEqual({ status: "succeeded" });
    expect(autoLogin).toHaveBeenCalledWith({ credential: { bankCode: "popular", username: "bank-user", password: "bank-password" }, page });
    expect(acquire).toHaveBeenCalledWith("popular", "E1");
    expect(release).toHaveBeenCalledWith("popular", "E1", "lease-1");
  });
});
