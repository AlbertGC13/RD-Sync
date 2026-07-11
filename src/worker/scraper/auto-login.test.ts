import { describe, expect, it, vi } from "vitest";

import { encryptCredentialField } from "../../modules/bank-credentials/crypto";
import { createBankAutoLoginStrategy, createScrapeTimeAutoLoginBrowserOpener, createScrapeTimeAutoLoginProductionOpener, createScrapeTimeAutoLoginRunner, executeScrapeTimeAutoLoginTrigger, unavailableScrapeTimeAutoLoginBrowserOpener, type BankAutoLoginPage } from "./auto-login";
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

function readyBrowser(page: BankAutoLoginPage) {
  return {
    status: "ready" as const,
    page,
    close: vi.fn().mockResolvedValue(undefined),
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
    const close = vi.fn(() => { events.push("browser closed"); return Promise.resolve(); });
    const ensureBrowser = vi.fn(() => Promise.resolve({ status: "ready" as const, page }).then((browser) => {
      events.push("ensureBrowser settled");
      return { ...browser, close };
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
    expect(events).toEqual(["ensureBrowser settled", "autoLogin settled", "browser closed", "release started"]);

    releaseSettledResolve(true);
    await expect(result).resolves.toEqual({ status: "succeeded" });

    expect(acquire).toHaveBeenCalledWith("popular", "E1");
    expect(ensureBrowser).toHaveBeenCalledWith("http://127.0.0.1:9222");
    expect(autoLogin).toHaveBeenCalledWith({ credential, page });
    expect(close).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith("popular", "E1", "lease-1");
    expect(events).toEqual(["ensureBrowser settled", "autoLogin settled", "browser closed", "release started", "helper resolved"]);
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
    const events: string[] = [];
    const release = vi.fn(() => { events.push("lock.release"); return Promise.resolve(true); });
    const autoLogin = vi.fn().mockResolvedValue({
      status: "needs_admin_action",
      reason: "protected_flow",
      safeSummary: "MFA is required",
    });
    const browser = readyBrowser(makePage());
    browser.close.mockImplementation(() => { events.push("browser.close"); return Promise.resolve(); });

    await expect(executeScrapeTimeAutoLoginTrigger({
      bankCode: "popular",
      expiredEventId: "E1",
      adapter: { bankCode: "popular", createAutoLoginStrategy: () => ({ bankCode: "popular", autoLogin }) },
      credential,
      cdpUrl: "http://127.0.0.1:9222",
      lock: { acquire: vi.fn().mockResolvedValue({ leaseToken: "lease-1", fencingToken: 7, expiresAt: 12345 }), release },
      ensureBrowser: vi.fn().mockResolvedValue(browser),
    })).resolves.toEqual({
      status: "needs_admin_action",
      reason: "protected_flow",
      safeSummary: "MFA is required",
    });

    expect(release).toHaveBeenCalledWith("popular", "E1", "lease-1");
    expect(events).toEqual(["browser.close", "lock.release"]);
  });

  it("owner-releases the lock and reports portal state unavailable when delegated login rejects", async () => {
    const events: string[] = [];
    const release = vi.fn(() => { events.push("lock.release"); return Promise.resolve(true); });
    const autoLogin = vi.fn().mockRejectedValue(new Error("portal token=secret crashed"));
    const browser = readyBrowser(makePage());
    browser.close.mockImplementation(() => { events.push("browser.close"); return Promise.resolve(); });

    await expect(executeScrapeTimeAutoLoginTrigger({
      bankCode: "popular",
      expiredEventId: "E1",
      adapter: { bankCode: "popular", createAutoLoginStrategy: () => ({ bankCode: "popular", autoLogin }) },
      credential,
      cdpUrl: "http://127.0.0.1:9222",
      lock: { acquire: vi.fn().mockResolvedValue({ leaseToken: "lease-1", fencingToken: 7, expiresAt: 12345 }), release },
      ensureBrowser: vi.fn().mockResolvedValue(browser),
    })).resolves.toEqual({
      status: "needs_admin_action",
      reason: "portal_state_unavailable",
      safeSummary: "Bank auto-login requires admin action",
    });

    expect(release).toHaveBeenCalledWith("popular", "E1", "lease-1");
    expect(events).toEqual(["browser.close", "lock.release"]);
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
      ensureBrowser: vi.fn().mockResolvedValue(readyBrowser(makePage())),
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
      ensureBrowser: vi.fn().mockResolvedValue(readyBrowser(makePage())),
      recordLockReleaseFailure,
    })).resolves.toEqual({ status: "succeeded" });

    expect(recordLockReleaseFailure.mock.calls).toEqual([[{ bankCode: "popular", expiredEventId: "E1" }]]);
  });

  it("swallows release failure hook rejections without changing admin outcomes", async () => {
    const release = vi.fn().mockRejectedValue(new Error("lock release failed"));
    const recordLockReleaseFailure = vi.fn().mockRejectedValue(new Error("metrics token=secret failed"));

    await expect(executeScrapeTimeAutoLoginTrigger({
      bankCode: "popular",
      expiredEventId: "E1",
      adapter: { bankCode: "popular", createAutoLoginStrategy: () => ({ bankCode: "popular", autoLogin: vi.fn().mockResolvedValue({ status: "needs_admin_action", reason: "protected_flow", safeSummary: "MFA is required" }) }) },
      credential,
      cdpUrl: "http://127.0.0.1:9222",
      lock: { acquire: vi.fn().mockResolvedValue({ leaseToken: "lease-1", fencingToken: 7, expiresAt: 12345 }), release },
      ensureBrowser: vi.fn().mockResolvedValue(readyBrowser(makePage())),
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
      ensureBrowser: vi.fn().mockResolvedValue(readyBrowser(makePage())),
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
      ensureBrowser: vi.fn().mockResolvedValue(readyBrowser(page)),
    });

    await expect(run({ data: { bankId: "popular", expiredEventId: "E1" } })).resolves.toEqual({ status: "succeeded" });
    expect(autoLogin).toHaveBeenCalledWith({ credential: { bankCode: "popular", username: "bank-user", password: "bank-password" }, page });
    expect(acquire).toHaveBeenCalledWith("popular", "E1");
    expect(release).toHaveBeenCalledWith("popular", "E1", "lease-1");
  });
});

describe("createScrapeTimeAutoLoginBrowserOpener", () => {
  const CDP_URL = "http://127.0.0.1:9222";
  const CLEANUP_TIMEOUT_MS = 2;
  const PAGE_SETUP_TIMEOUT_MS = 2;
  const POPULAR_LOGIN_URL = "https://ib.bpd.com.do/login";
  function makeCdpPage() {
    return {
      url: vi.fn(() => "https://ib.bpd.com.do/login"),
      goto: vi.fn(),
      waitForSelector: vi.fn((selector: string) => selector === "#missing"
        ? Promise.reject(Object.assign(new Error("not visible"), { name: "TimeoutError" })) : Promise.resolve({})),
      fill: vi.fn(), click: vi.fn(), close: vi.fn().mockResolvedValue(undefined),
    };
  }
  function makeBrowser(page: ReturnType<typeof makeCdpPage>) {
    return { contexts: vi.fn(() => [{ newPage: vi.fn().mockResolvedValue(page) }]), newPage: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
  }
  type OpenerOptions = Omit<Parameters<typeof createScrapeTimeAutoLoginBrowserOpener>[0], "trustedLoginUrl">;
  const open = (options: OpenerOptions) => createScrapeTimeAutoLoginBrowserOpener({ trustedLoginUrl: POPULAR_LOGIN_URL, ...options })("popular", CDP_URL);
  async function openReadyBrowser(options: OpenerOptions) {
    const result = await open(options);
    if (result.status !== "ready") throw new Error("expected ready browser");
    return result;
  }
  function makeDeferredPageSetup(stage: "newPage" | "goto") {
    let resolveSetup: () => void = () => undefined;
    const pendingSetup = new Promise<void>((resolve) => { resolveSetup = resolve; });
    const page = makeCdpPage();
    const browser = makeBrowser(page);
    if (stage === "newPage") browser.contexts.mockReturnValue([{ newPage: vi.fn(() => pendingSetup.then(() => page)) }]); else page.goto.mockImplementation(() => pendingSetup);
    return { page, browser, release: vi.fn().mockResolvedValue(undefined), resolveSetup };
  }
  it("maps Popular's trusted URL and validates the supplied CDP endpoint", async () => {
    const page = makeCdpPage();
    const runtime = vi.fn().mockResolvedValue({ ok: true, launched: false });
    const result = await createScrapeTimeAutoLoginProductionOpener({
      connect: vi.fn().mockResolvedValue(makeBrowser(page)), ensureBrowserRuntimeForCdpUrl: runtime,
      trustedLoginUrlForBank: (bankCode) => bankCode === "popular" ? POPULAR_LOGIN_URL : undefined,
    })("popular", CDP_URL);
    if (result.status !== "ready") throw new Error("expected ready browser");
    await result.close();
    expect(runtime).toHaveBeenCalledWith(CDP_URL);
    expect(page.goto).toHaveBeenCalledWith(POPULAR_LOGIN_URL);
  });
  it("fails closed without a trusted URL", async () => {
    const connect = vi.fn();
    const production = createScrapeTimeAutoLoginProductionOpener({ connect, trustedLoginUrlForBank: () => undefined, ensureBrowserRuntimeForCdpUrl: vi.fn() });
    await expect(production("untrusted", CDP_URL)).rejects.toThrow("Bank login page is not configured");
    expect(connect).not.toHaveBeenCalled();
  });
  it("does not connect after a safe runtime readiness failure", async () => {
    const connect = vi.fn();
    const runtime = vi.fn().mockResolvedValue({ ok: false, launched: false, safeErrorSummary: "Bank browser did not become ready in time" });
    await expect(createScrapeTimeAutoLoginProductionOpener({ connect, trustedLoginUrlForBank: () => POPULAR_LOGIN_URL, ensureBrowserRuntimeForCdpUrl: runtime })("popular", CDP_URL)).rejects.toThrow("Bank browser did not become ready in time");
    expect(connect).not.toHaveBeenCalled();
    expect(runtime).toHaveBeenCalledWith(CDP_URL);
  });
  it("cleans up the slot and browser after an immediate default-context page rejection", async () => {
    const release = vi.fn().mockResolvedValue(undefined);
    const browser = makeBrowser(makeCdpPage());
    browser.contexts.mockReturnValue([{ newPage: vi.fn().mockRejectedValue(new Error("page creation failed")) }]);
    await expect(open({ connect: vi.fn().mockResolvedValue(browser), acquireBrowserSlot: vi.fn().mockResolvedValue({ kind: "acquired", release }) })).rejects.toThrow("page creation failed");
    expect([browser.close, release].map((fn) => fn.mock.calls.length)).toEqual([1, 1]);
  });
  it("cleans up the page, browser, and slot after trusted navigation rejects", async () => {
    const release = vi.fn().mockResolvedValue(undefined);
    const page = makeCdpPage();
    page.goto.mockRejectedValue(new Error("navigation failed"));
    const browser = makeBrowser(page);
    await expect(open({ connect: vi.fn().mockResolvedValue(browser), acquireBrowserSlot: vi.fn().mockResolvedValue({ kind: "acquired", release }) })).rejects.toThrow("navigation failed");
    expect([page.close, browser.close, release].map((fn) => fn.mock.calls.length)).toEqual([1, 1, 1]);
  });
  it.each([
    ["slot never settles", "browser_slot_release_failed", "slot", "never settles"],
    ["page never settles", "page_close_failed", "page", "never settles"],
    ["browser rejects", "browser_close_failed", "browser", "rejects"],
    ["browser never settles", "browser_close_failed", "browser", "never settles"],
  ] as const)("records a safe %s cleanup failure", async (_, failure, resource, mode) => {
    const rawCdpDetail = "CDP ws://operator:secret@127.0.0.1:9222";
    const failures = vi.fn().mockResolvedValue(undefined);
    const never = () => new Promise<void>(() => undefined);
    const page = { ...makeCdpPage(), close: vi.fn(resource === "page" ? never : () => Promise.resolve()) };
    const browser = makeBrowser(page);
    browser.close.mockImplementation(() => resource !== "browser" ? Promise.resolve() : mode === "rejects" ? Promise.reject(new Error(rawCdpDetail)) : never());
    const release = vi.fn(resource === "slot" ? never : () => Promise.resolve());
    await (await openReadyBrowser({ connect: vi.fn().mockResolvedValue(browser), acquireBrowserSlot: vi.fn().mockResolvedValue({ kind: "acquired", release }), cleanupTimeoutMs: CLEANUP_TIMEOUT_MS, recordCleanupFailure: failures })).close();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(failures).toHaveBeenCalledWith({ bankCode: "popular", failure });
    expect(JSON.stringify(failures.mock.calls)).not.toContain(rawCdpDetail);
  });
  it.each([
    ["newPage remains pending", "newPage", 0, [0, 1, 1]], ["trusted goto remains pending", "goto", 1, [1, 1, 1]],
  ] as const)("bounds page setup when %s past the timeout", async (_, stage, expectedGotoCalls, cleanupBeforeResolution) => {
    vi.useFakeTimers();
    try {
      const { page, browser, release, resolveSetup } = makeDeferredPageSetup(stage);
      const opening = open({ connect: vi.fn().mockResolvedValue(browser),
        acquireBrowserSlot: vi.fn().mockResolvedValue({ kind: "acquired", release }), pageSetupTimeoutMs: PAGE_SETUP_TIMEOUT_MS });
      const rejected = expect(opening).rejects.toThrow("Timed out while preparing the trusted bank login page");
      await vi.advanceTimersByTimeAsync(PAGE_SETUP_TIMEOUT_MS);
      await rejected;
      expect([page.close, browser.close, release].map((cleanup) => cleanup.mock.calls.length)).toEqual(cleanupBeforeResolution);
      resolveSetup();
      await vi.advanceTimersByTimeAsync(0);
      expect([page.close, browser.close, release].map((cleanup) => cleanup.mock.calls.length)).toEqual([1, 1, 1]);
      expect(page.goto).toHaveBeenCalledTimes(expectedGotoCalls);
    } finally {
      vi.useRealTimers();
    }
  });
});
