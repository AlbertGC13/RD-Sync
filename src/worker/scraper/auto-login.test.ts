import { describe, expect, it, vi } from "vitest";

import { encryptCredentialField } from "../../modules/bank-credentials/crypto";
import { CREDENTIAL_SCRUB_TIMEOUT_MS, DEFAULT_VISIBLE_SELECTOR_TIMEOUT_MS, createBankAutoLoginStrategy, createScrapeTimeAutoLoginBrowserOpener, createScrapeTimeAutoLoginRunner, executeScrapeTimeAutoLoginTrigger, parseAutoLoginSelectorTimeoutMs, unavailableScrapeTimeAutoLoginBrowserOpener, type BankAutoLoginPage } from "./auto-login";
import { MIN_PROTECTED_STATE_DETECTION_WINDOW_MS, type BankPortalConfig } from "./login-mutation-guard";

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

function makePage(options: { url?: string; visible?: readonly string[]; onFill?: (selector: string, value: string) => void | Promise<void>; onClick?: () => void | Promise<void> } = {}): TestBankAutoLoginPage {
  let url = options.url ?? "https://ib.bpd.com.do/login";
  const visible = new Set(options.visible ?? loginControls);
  return {
    async currentUrl() { return url; },
    async hasVisibleSelector(selector) { return visible.has(selector); },
    async fill(selector, value) { await options.onFill?.(selector, value); },
    async click() {
      if (options.onClick) await options.onClick();
      else url = "https://ib.bpd.com.do/dashboard";
    },
    setUrl(nextUrl: string) { url = nextUrl; },
    show(selector: string) { visible.add(selector); },
  };
}

type MutationPhase = "username" | "password" | "submit";

function makeMutationBoundaryDriftPage(driftBefore: MutationPhase) {
  let url = "https://ib.bpd.com.do/login";
  let phase: MutationPhase = "username";
  const mutations: string[] = [];
  const visible = new Set(loginControls);
  const page: BankAutoLoginPage = {
    async currentUrl() { return url; },
    async hasVisibleSelector(selector) {
      if (phase === driftBefore && selector === portalConfig.usernameSelector) {
        await Promise.resolve();
        url = "https://evil.example/login";
      }
      return visible.has(selector as (typeof loginControls)[number]);
    },
    // Records credential-bearing fills only. The abort path also clears the
    // inputs with an empty value; that is cleanup, not a mutation crossing a
    // boundary, and counting it would blur what these cases assert.
    async fill(selector, value) {
      if (value === "") return;
      mutations.push(selector);
      phase = selector === portalConfig.usernameSelector ? "password" : "submit";
    },
    async click(selector) { mutations.push(selector); },
  };
  return { page, mutations };
}

function readyBrowser(page: BankAutoLoginPage) {
  return {
    status: "ready" as const,
    page,
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe("createBankAutoLoginStrategy", () => {
  // Guarding the composition, not just the guard, and asserting the EFFECTIVE
  // wait that reaches the page rather than the argument a call site passes. An
  // earlier version asserted `undefined` at the submit boundary, which proved
  // only that the call site declined to override — it could not tell a 10s
  // detection window from a 1s one.
  async function recordAbsenceProbes(declaredWindowMs?: number): Promise<Array<number | undefined>> {
    const probes: Array<number | undefined> = [];
    const page = makePage();
    const recordingPage = {
      ...page,
      protectedStateDetectionWindowMs: declaredWindowMs,
      hasVisibleSelector: async (selector: string, timeoutMs?: number) => {
        if (selector === portalConfig.mfaIndicatorSelector || selector === portalConfig.incompatibleFlowSelector) probes.push(timeoutMs);
        return page.hasVisibleSelector(selector);
      },
    };

    await expect(createBankAutoLoginStrategy(portalConfig, { supportedBankCodes: ["popular"] })
      .autoLogin({ credential, page: recordingPage })).resolves.toEqual({ status: "succeeded" });

    // Three pre-submit passes, two absence selectors each.
    return probes.slice(0, 6);
  }

  // Every boundary, not just the submit. A shortened wait before the fills is
  // what let credentials reach the DOM ahead of a late overlay.
  it("gives all three mutation boundaries the full detection window", async () => {
    const preSubmit = await recordAbsenceProbes();

    expect(preSubmit).toEqual(Array<number>(6).fill(MIN_PROTECTED_STATE_DETECTION_WINDOW_MS));
  });

  // The page's visibility timeout is environment-configurable down to 1s. That
  // knob must not be able to collapse the window protecting the submit.
  it("clamps a page-declared detection window narrower than the safety floor", async () => {
    const preSubmit = await recordAbsenceProbes(1_000);

    expect(preSubmit.slice(4)).toEqual([
      MIN_PROTECTED_STATE_DETECTION_WINDOW_MS, MIN_PROTECTED_STATE_DETECTION_WINDOW_MS,
    ]);
  });

  it("honors a page-declared detection window wider than the safety floor", async () => {
    const widened = MIN_PROTECTED_STATE_DETECTION_WINDOW_MS * 2;
    const preSubmit = await recordAbsenceProbes(widened);

    expect(preSubmit.slice(4)).toEqual([widened, widened]);
  });

  // The detection window closes the gap BETWEEN guard passes; it cannot close
  // the instant between a pass and the fill that follows it. An overlay landing
  // there is caught by the next boundary, but the password is already in the
  // page by then - and must not be left there.
  it("clears the credential inputs when a protected state appears after the password fill", async () => {
    let reveal: (selector: string) => void = () => undefined;
    const fills: Array<{ selector: string; value: string }> = [];
    const page = makePage({
      onFill: (selector, value) => {
        fills.push({ selector, value });
        if (selector === portalConfig.passwordSelector && value !== "") reveal(portalConfig.mfaIndicatorSelector);
      },
    });
    reveal = page.show;

    await expect(createBankAutoLoginStrategy(portalConfig, { supportedBankCodes: ["popular"] })
      .autoLogin({ credential, page })).resolves.toMatchObject({ status: "needs_admin_action", reason: "protected_flow" });

    expect(fills.map((entry) => entry.value)).toEqual([credential.username, credential.password, "", ""]);
    // Password first: it is the value that matters most if clearing is cut short.
    expect(fills.slice(2).map((entry) => entry.selector)).toEqual([portalConfig.passwordSelector, portalConfig.usernameSelector]);
  });

  it("reports the abort reason even when clearing the credential inputs fails", async () => {
    let reveal: (selector: string) => void = () => undefined;
    const page = makePage({
      onFill: (selector, value) => {
        if (value === "") throw new Error("detached frame");
        if (selector === portalConfig.passwordSelector) reveal(portalConfig.mfaIndicatorSelector);
      },
    });
    reveal = page.show;

    await expect(createBankAutoLoginStrategy(portalConfig, { supportedBankCodes: ["popular"] })
      .autoLogin({ credential, page })).resolves.toMatchObject({ status: "needs_admin_action", reason: "protected_flow" });
  });

  // Swallowing rejections is not enough to make cleanup non-blocking. A fill
  // that never settles would hold the abort outcome forever, and with it the
  // browser close and the lock release, so each clear carries its own deadline.
  it("does not hold the abort outcome when clearing an input never settles", async () => {
    vi.useFakeTimers();
    try {
      let reveal: (selector: string) => void = () => undefined;
      const cleared: string[] = [];
      const page = makePage({
        onFill: (selector, value) => {
          if (value === "") {
            cleared.push(selector);
            return new Promise<void>(() => undefined); // never settles
          }
          if (selector === portalConfig.passwordSelector) reveal(portalConfig.mfaIndicatorSelector);
        },
      });
      reveal = page.show;

      const pending = createBankAutoLoginStrategy(portalConfig, { supportedBankCodes: ["popular"] })
        .autoLogin({ credential, page });

      await vi.advanceTimersByTimeAsync(CREDENTIAL_SCRUB_TIMEOUT_MS * 2 + 50);

      await expect(pending).resolves.toMatchObject({ status: "needs_admin_action", reason: "protected_flow" });
      // A hung password clear must not cost the username its own attempt.
      expect(cleared).toEqual([portalConfig.passwordSelector, portalConfig.usernameSelector]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fills and submits only after the guard authorizes all three mutation boundaries", async () => {
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
    const fill = vi.fn<(selector: string, value: string) => void>((selector) => {
      if (selector === portalConfig.usernameSelector) setPageUrl("https://evil.example/login");
    });
    const page = makePage({ onFill: fill });
    setPageUrl = page.setUrl;
    const click = vi.spyOn(page, "click");

    await expect(createBankAutoLoginStrategy(portalConfig).autoLogin({ credential, page })).resolves.toMatchObject({
      status: "needs_admin_action",
      reason: "unauthorized_login_page",
    });
    const credentialFills = fill.mock.calls.filter(([, value]) => value !== "");
    expect(credentialFills).toEqual([["#username", "bank-user"]]);
    expect(click).not.toHaveBeenCalled();
  });

  it("re-checks the guard before submit so redirects after password fill cannot submit credentials", async () => {
    let setPageUrl: (nextUrl: string) => void = () => undefined;
    const fill = vi.fn<(selector: string, value: string) => void>((selector) => {
      if (selector === portalConfig.passwordSelector) setPageUrl("https://evil.example/login");
    });
    const page = makePage({ onFill: fill });
    setPageUrl = page.setUrl;
    const click = vi.spyOn(page, "click");

    await expect(createBankAutoLoginStrategy(portalConfig).autoLogin({ credential, page })).resolves.toMatchObject({
      status: "needs_admin_action",
      reason: "unauthorized_login_page",
    });
    const credentialFills = fill.mock.calls.filter(([, value]) => value !== "");
    expect(credentialFills).toEqual([["#username", "bank-user"], ["#password", "bank-password"]]);
    // Aborting after the password landed must also clear it.
    expect(fill.mock.calls.slice(credentialFills.length)).toEqual([["#password", ""], ["#username", ""]]);
    expect(click).not.toHaveBeenCalled();
  });

  it.each([
    ["username", []],
    ["password", [portalConfig.usernameSelector]],
    ["submit", [portalConfig.usernameSelector, portalConfig.passwordSelector]],
  ] as const)("blocks the %s mutation when navigation drifts during its boundary checks", async (phase, expectedMutations) => {
    const { page, mutations } = makeMutationBoundaryDriftPage(phase);

    await expect(createBankAutoLoginStrategy(portalConfig).autoLogin({ credential, page })).resolves.toMatchObject({
      status: "needs_admin_action",
      reason: "unauthorized_login_page",
    });

    expect(mutations).toEqual(expectedMutations);
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

  it("blocks success when a protected challenge is exposed during the submit click", async () => {
    const page = makePage({
      onClick: async () => {
        await Promise.resolve();
        page.show(portalConfig.mfaIndicatorSelector);
      },
    });

    await expect(createBankAutoLoginStrategy(portalConfig).autoLogin({ credential, page })).resolves.toMatchObject({
      status: "needs_admin_action",
      reason: "protected_flow",
    });
  });

  it("re-checks protected state when a challenge appears during dashboard URL acquisition", async () => {
    let clickCompleted = false;
    let challengeVisible = false;
    const page: BankAutoLoginPage = {
      async currentUrl() {
        if (!clickCompleted) return "https://ib.bpd.com.do/login";
        challengeVisible = true;
        return "https://ib.bpd.com.do/dashboard";
      },
      async hasVisibleSelector(selector) {
        if (selector === portalConfig.mfaIndicatorSelector) return challengeVisible;
        return loginControls.includes(selector as (typeof loginControls)[number]);
      },
      async fill() {},
      async click() { clickCompleted = true; },
    };

    await expect(createBankAutoLoginStrategy(portalConfig).autoLogin({ credential, page })).resolves.toMatchObject({
      status: "needs_admin_action",
      reason: "protected_flow",
    });
  });

  it("fails closed when a post-submit protected-state selector throws unexpectedly", async () => {
    let clickCompleted = false;
    const page: BankAutoLoginPage = {
      async currentUrl() { return clickCompleted ? "https://ib.bpd.com.do/dashboard" : "https://ib.bpd.com.do/login"; },
      async hasVisibleSelector(selector) {
        if (clickCompleted && selector === portalConfig.mfaIndicatorSelector) throw new Error("selector diagnostics must not leak");
        return loginControls.includes(selector as (typeof loginControls)[number]);
      },
      async fill() {},
      async click() { clickCompleted = true; },
    };

    await expect(createBankAutoLoginStrategy(portalConfig).autoLogin({ credential, page })).resolves.toMatchObject({
      status: "needs_admin_action",
      reason: "portal_state_unavailable",
    });
  });
});

describe("executeScrapeTimeAutoLoginTrigger", () => {
  it("runs the mutation hook once immediately before the first credential fill", async () => {
    const events: string[] = [];
    const page = makePage({ onFill: (selector) => { events.push(`fill:${selector}`); } });
    const beforeAutoLoginMutation = vi.fn(() => { events.push("before"); return true; });

    await expect(executeScrapeTimeAutoLoginTrigger({
      bankCode: "popular", expiredEventId: "E1", credential, cdpUrl: "http://127.0.0.1:9222",
      adapter: { bankCode: "popular", createAutoLoginStrategy: () => createBankAutoLoginStrategy(portalConfig) },
      lock: { acquire: vi.fn().mockResolvedValue({ leaseToken: "lease-1", fencingToken: 1, expiresAt: 123 }), release: vi.fn().mockResolvedValue(true) },
      ensureBrowser: vi.fn().mockResolvedValue(readyBrowser(page)), beforeAutoLoginMutation,
    })).resolves.toEqual({ status: "succeeded" });

    expect(beforeAutoLoginMutation).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["before", "fill:#username", "fill:#password"]);
  });

  // The mutation hook wraps the page. An adapter that declares fewer parameters
  // than the interface stays assignable in TypeScript, so a dropped `timeoutMs`
  // silently reverts every probe to the page default and discards the guard's
  // choice without a compile error or a failing behavioural test.
  it("forwards the probe timeout through the mutation-hook page wrapper", async () => {
    const probes: Array<number | undefined> = [];
    const page = makePage();
    const recordingPage = {
      ...page,
      hasVisibleSelector: async (selector: string, timeoutMs?: number) => {
        probes.push(timeoutMs);
        return page.hasVisibleSelector(selector);
      },
    };

    await expect(executeScrapeTimeAutoLoginTrigger({
      bankCode: "popular", expiredEventId: "E1", credential, cdpUrl: "http://127.0.0.1:9222",
      adapter: { bankCode: "popular", createAutoLoginStrategy: () => createBankAutoLoginStrategy(portalConfig) },
      lock: { acquire: vi.fn().mockResolvedValue({ leaseToken: "lease-1", fencingToken: 1, expiresAt: 123 }), release: vi.fn().mockResolvedValue(true) },
      ensureBrowser: vi.fn().mockResolvedValue(readyBrowser(recordingPage)),
      beforeAutoLoginMutation: vi.fn().mockResolvedValue(true),
    })).resolves.toEqual({ status: "succeeded" });

    expect(probes.some((timeoutMs) => timeoutMs === MIN_PROTECTED_STATE_DETECTION_WINDOW_MS)).toBe(true);
  });

  it("fails closed when the mutation hook rejects or denies the compare-and-set", async () => {
    for (const beforeAutoLoginMutation of [vi.fn().mockResolvedValue(false), vi.fn().mockRejectedValue(new Error("CAS token=secret failed"))]) {
      const fill = vi.fn();
      const click = vi.fn();
      await expect(executeScrapeTimeAutoLoginTrigger({
        bankCode: "popular", expiredEventId: "E1", credential, cdpUrl: "http://127.0.0.1:9222",
        adapter: { bankCode: "popular", createAutoLoginStrategy: () => createBankAutoLoginStrategy(portalConfig) },
        lock: { acquire: vi.fn().mockResolvedValue({ leaseToken: "lease-1", fencingToken: 1, expiresAt: 123 }), release: vi.fn().mockResolvedValue(true) },
        ensureBrowser: vi.fn().mockResolvedValue(readyBrowser(makePage({ onFill: fill, onClick: click }))), beforeAutoLoginMutation,
      })).resolves.toMatchObject({ status: "needs_admin_action", reason: "portal_state_unavailable" });
      expect(beforeAutoLoginMutation).toHaveBeenCalledTimes(1);
      expect(fill).not.toHaveBeenCalled();
      expect(click).not.toHaveBeenCalled();
    }
  });

  it("reports safe terminal outcomes without credentials and never reports success after a fill failure", async () => {
    const successOutcome = vi.fn();
    await executeScrapeTimeAutoLoginTrigger({
      bankCode: "popular", expiredEventId: "E1", credential, cdpUrl: "http://127.0.0.1:9222",
      adapter: { bankCode: "popular", createAutoLoginStrategy: () => createBankAutoLoginStrategy(portalConfig) },
      lock: { acquire: vi.fn().mockResolvedValue({ leaseToken: "lease-1", fencingToken: 1, expiresAt: 123 }), release: vi.fn().mockResolvedValue(true) },
      ensureBrowser: vi.fn().mockResolvedValue(readyBrowser(makePage())), afterAutoLoginOutcome: successOutcome,
    });
    expect(successOutcome).toHaveBeenCalledWith({ bankCode: "popular", expiredEventId: "E1", outcome: { status: "succeeded" } });

    const uncertainOutcome = vi.fn();
    const page = makePage({ onFill: (selector) => { if (selector === portalConfig.passwordSelector) throw new Error("portal token=secret crashed"); } });
    await expect(executeScrapeTimeAutoLoginTrigger({
      bankCode: "popular", expiredEventId: "E1", credential, cdpUrl: "http://127.0.0.1:9222",
      adapter: { bankCode: "popular", createAutoLoginStrategy: () => createBankAutoLoginStrategy(portalConfig) },
      lock: { acquire: vi.fn().mockResolvedValue({ leaseToken: "lease-1", fencingToken: 1, expiresAt: 123 }), release: vi.fn().mockResolvedValue(true) },
      ensureBrowser: vi.fn().mockResolvedValue(readyBrowser(page)), afterAutoLoginOutcome: uncertainOutcome,
    })).resolves.toMatchObject({ status: "needs_admin_action", reason: "portal_state_unavailable" });
    expect(uncertainOutcome).toHaveBeenCalledWith({ bankCode: "popular", expiredEventId: "E1", outcome: { status: "needs_admin_action", reason: "portal_state_unavailable", safeSummary: "Bank auto-login requires admin action" } });
    expect(uncertainOutcome.mock.calls).not.toContainEqual(expect.arrayContaining([expect.objectContaining({ outcome: { status: "succeeded" } })]));
  });

  it("preserves the protected-flow outcome when outcome persistence fails", async () => {
    const afterAutoLoginOutcome = vi.fn().mockRejectedValue(new Error("audit token=secret unavailable"));

    await expect(executeScrapeTimeAutoLoginTrigger({
      bankCode: "popular", expiredEventId: "E1", credential, cdpUrl: "http://127.0.0.1:9222",
      adapter: { bankCode: "popular", createAutoLoginStrategy: () => createBankAutoLoginStrategy(portalConfig) },
      lock: { acquire: vi.fn().mockResolvedValue({ leaseToken: "lease-1", fencingToken: 1, expiresAt: 123 }), release: vi.fn().mockResolvedValue(true) },
      ensureBrowser: vi.fn().mockResolvedValue(readyBrowser(makePage())), afterAutoLoginOutcome,
    })).resolves.toEqual({ status: "succeeded" });

    expect(afterAutoLoginOutcome).toHaveBeenCalledTimes(1);
  });

  it("does not call the mutation hook before lock, browser, throttle, or guard rejections", async () => {
    const beforeAutoLoginMutation = vi.fn();
    const base = {
      bankCode: "popular", expiredEventId: "E1", credential, cdpUrl: "http://127.0.0.1:9222",
      adapter: { bankCode: "popular", createAutoLoginStrategy: () => createBankAutoLoginStrategy(portalConfig) },
      beforeAutoLoginMutation,
    };

    await executeScrapeTimeAutoLoginTrigger({ ...base, lock: { acquire: vi.fn().mockRejectedValue(new Error("lock unavailable")), release: vi.fn() }, ensureBrowser: vi.fn() });
    await executeScrapeTimeAutoLoginTrigger({ ...base, lock: { acquire: vi.fn().mockResolvedValue({ leaseToken: "lease-1", fencingToken: 1, expiresAt: 123 }), release: vi.fn() }, ensureBrowser: vi.fn().mockRejectedValue(new Error("browser unavailable")) });
    await executeScrapeTimeAutoLoginTrigger({ ...base, lock: { acquire: vi.fn().mockResolvedValue({ leaseToken: "lease-1", fencingToken: 1, expiresAt: 123 }), release: vi.fn() }, ensureBrowser: vi.fn().mockResolvedValue({ status: "throttled" }) });
    await executeScrapeTimeAutoLoginTrigger({
      ...base,
      lock: { acquire: vi.fn().mockResolvedValue({ leaseToken: "lease-1", fencingToken: 1, expiresAt: 123 }), release: vi.fn() },
      ensureBrowser: vi.fn().mockResolvedValue(readyBrowser(makePage({ visible: [portalConfig.mfaIndicatorSelector, ...loginControls] }))),
    });

    expect(beforeAutoLoginMutation).not.toHaveBeenCalled();
  });

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

  it("does not call the mutation hook when config is off or credentials are absent", async () => {
    const beforeAutoLoginMutation = vi.fn();
    for (const [config, storedCredential] of [
      [{ autoLoginEnabled: false, breakerState: "closed" }, encryptedCredentialRecord()],
      [{ autoLoginEnabled: true, breakerState: "closed" }, null],
    ] as const) {
      const run = createScrapeTimeAutoLoginRunner({
        adapterRegistry: { get: vi.fn().mockReturnValue({ bankCode: "popular", createAutoLoginStrategy: vi.fn() }) },
        autoLoginConfigs: { getByBankCode: vi.fn().mockResolvedValue(config) },
        credentials: { findByBankCode: vi.fn().mockResolvedValue(storedCredential) },
        keyResolver,
        lock: { acquire: vi.fn(), release: vi.fn() },
        cdpUrlForBankCode: vi.fn(),
        ensureBrowser: vi.fn(),
        beforeAutoLoginMutation,
      });

      await run({ data: { bankId: "popular", expiredEventId: "E1" } });
    }
    expect(beforeAutoLoginMutation).not.toHaveBeenCalled();
  });

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
    const afterAutoLoginOutcome = vi.fn();
    const run = createScrapeTimeAutoLoginRunner({
      adapterRegistry: { get: vi.fn().mockReturnValue({ bankCode: "popular", createAutoLoginStrategy: vi.fn() }) },
      autoLoginConfigs: { getByBankCode: vi.fn().mockResolvedValue({ autoLoginEnabled: false, breakerState: "closed" }) },
      credentials: { findByBankCode },
      keyResolver,
      lock: { acquire, release: vi.fn() },
      cdpUrlForBankCode: vi.fn(),
      ensureBrowser: vi.fn(),
      afterAutoLoginOutcome,
    });
    await expect(run({ data: { bankId: "popular", expiredEventId: "E1" } })).resolves.toEqual({
      status: "skipped", reason: "disabled", safeSummary: "Manual scrape required before retrying bank auto-login",
    });
    expect(findByBankCode).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
    expect(afterAutoLoginOutcome).toHaveBeenCalledWith({
      bankCode: "popular",
      expiredEventId: "E1",
      outcome: { status: "skipped", reason: "disabled", safeSummary: "Manual scrape required before retrying bank auto-login" },
    });
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

  it("records only executed unknown post-submit failures and skips after the breaker opens", async () => {
    let breakerState: "closed" | "open" = "closed";
    const recordFailure = vi.fn(async () => { if (recordFailure.mock.calls.length === 3) breakerState = "open"; });
    const outcomes = [
      { status: "needs_admin_action" as const, reason: "protected_flow" as const, safeSummary: "MFA required" },
      ...Array.from({ length: 3 }, () => ({ status: "needs_admin_action" as const, reason: "unknown_post_submit_state" as const, safeSummary: "Unknown state" })),
    ];
    const autoLogin = vi.fn(async () => outcomes.shift()!);
    const run = createScrapeTimeAutoLoginRunner({
      adapterRegistry: { get: () => ({ bankCode: "popular", createAutoLoginStrategy: () => ({ bankCode: "popular", autoLogin }) }) },
      autoLoginConfigs: { getByBankCode: async () => ({ autoLoginEnabled: true, breakerState }) },
      credentials: { findByBankCode: async () => encryptedCredentialRecord() }, keyResolver,
      lock: { acquire: async () => ({ leaseToken: "lease", fencingToken: 1, expiresAt: 1 }), release: async () => true },
      cdpUrlForBankCode: () => "http://127.0.0.1:9222", ensureBrowser: async () => readyBrowser(makePage()), recordFailure,
    });

    await run({ data: { bankId: "popular", expiredEventId: "event-mfa" } });
    await run({ data: { bankId: "popular", expiredEventId: "event-1" } });
    await run({ data: { bankId: "popular", expiredEventId: "event-2" } });
    await run({ data: { bankId: "popular", expiredEventId: "event-3" } });
    await run({ data: { bankId: "popular", expiredEventId: "event-open" } });

    expect(recordFailure).toHaveBeenCalledTimes(3);
    expect(autoLogin).toHaveBeenCalledTimes(4);
  });

  it("fails closed without leaking persistence errors when an executed failure cannot update the breaker", async () => {
    const rawRejection = "database token=secret password=bank-password unavailable";
    const autoLogin = vi.fn().mockResolvedValue({ status: "needs_admin_action" as const, reason: "unknown_post_submit_state" as const, safeSummary: "Unknown state" });
    const recordFailure = vi.fn().mockRejectedValue(new Error(rawRejection));
    const run = createScrapeTimeAutoLoginRunner({
      adapterRegistry: { get: () => ({ bankCode: "popular", createAutoLoginStrategy: () => ({ bankCode: "popular", autoLogin }) }) },
      autoLoginConfigs: { getByBankCode: async () => ({ autoLoginEnabled: true, breakerState: "closed" }) },
      credentials: { findByBankCode: async () => encryptedCredentialRecord() }, keyResolver,
      lock: { acquire: async () => ({ leaseToken: "lease", fencingToken: 1, expiresAt: 1 }), release: async () => true },
      cdpUrlForBankCode: () => "http://127.0.0.1:9222", ensureBrowser: async () => readyBrowser(makePage()), recordFailure,
    });

    const result = await run({ data: { bankId: "popular", expiredEventId: "event-persist-failure" } });

    expect(result).toEqual({ status: "needs_admin_action", reason: "unknown_post_submit_state", safeSummary: "Unknown state" });
    expect(recordFailure).toHaveBeenCalledTimes(1);
    expect(autoLogin).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain("bank-password");
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
  function cleanupCallCounts(page: ReturnType<typeof makeCdpPage>, browser: ReturnType<typeof makeBrowser>, release: ReturnType<typeof vi.fn>) {
    return { page: page.close.mock.calls.length, browser: browser.close.mock.calls.length, browserSlot: release.mock.calls.length };
  }
  function makeDeferredPageSetup(stage: "newPage" | "goto") {
    let resolveSetup: () => void = () => undefined;
    const pendingSetup = new Promise<void>((resolve) => { resolveSetup = resolve; });
    const page = makeCdpPage();
    const browser = makeBrowser(page);
    if (stage === "newPage") browser.contexts.mockReturnValue([{ newPage: vi.fn(() => pendingSetup.then(() => page)) }]); else page.goto.mockImplementation(() => pendingSetup);
    return { page, browser, release: vi.fn().mockResolvedValue(undefined), resolveSetup };
  }
  it.each([
    [undefined, DEFAULT_VISIBLE_SELECTOR_TIMEOUT_MS], ["", DEFAULT_VISIBLE_SELECTOR_TIMEOUT_MS], ["  ", DEFAULT_VISIBLE_SELECTOR_TIMEOUT_MS],
    ["invalid", DEFAULT_VISIBLE_SELECTOR_TIMEOUT_MS], ["Infinity", DEFAULT_VISIBLE_SELECTOR_TIMEOUT_MS], ["-1", 1_000],
    ["999", 1_000], ["30001", 30_000], ["1200.9", 1_200], ["7000", 7_000],
  ])("parses selector timeout %j safely", (value, expected) => {
    expect(parseAutoLoginSelectorTimeoutMs(value)).toBe(expected);
  });
  it("never exposes the raw selector timeout environment value", () => {
    const rawValue = "1200 token=secret";
    expect(JSON.stringify(parseAutoLoginSelectorTimeoutMs(rawValue))).not.toContain(rawValue);
  });
  it("waits for a selector visible at 700ms by default but honors a 500ms test injection", async () => {
    const page = makeCdpPage();
    page.waitForSelector.mockImplementation((_selector: string, options?: { timeout?: number }) =>
      options?.timeout && options.timeout >= 700
        ? Promise.resolve({})
        : Promise.reject(Object.assign(new Error("not visible"), { name: "TimeoutError" })),
    );
    const browser = makeBrowser(page);
    const original = process.env.RD_SYNC_AUTOLOGIN_SELECTOR_TIMEOUT_MS;
    delete process.env.RD_SYNC_AUTOLOGIN_SELECTOR_TIMEOUT_MS;
    try {
      const defaultBrowser = await openReadyBrowser({ connect: vi.fn().mockResolvedValue(browser) });
      await expect(defaultBrowser.page.hasVisibleSelector("#delayed")).resolves.toBe(true);
      await defaultBrowser.close();
      const injectedBrowser = await openReadyBrowser({ connect: vi.fn().mockResolvedValue(makeBrowser(page)), visibleSelectorTimeoutMs: 500 });
      await expect(injectedBrowser.page.hasVisibleSelector("#delayed")).resolves.toBe(false);
      await injectedBrowser.close();
    } finally {
      if (original === undefined) delete process.env.RD_SYNC_AUTOLOGIN_SELECTOR_TIMEOUT_MS;
      else process.env.RD_SYNC_AUTOLOGIN_SELECTOR_TIMEOUT_MS = original;
    }
  });
  it("cleans up the slot and browser after an immediate default-context page rejection", async () => {
    const release = vi.fn().mockResolvedValue(undefined);
    const browser = makeBrowser(makeCdpPage());
    browser.contexts.mockReturnValue([{ newPage: vi.fn().mockRejectedValue(new Error("page creation failed")) }]);
    await expect(open({ connect: vi.fn().mockResolvedValue(browser), acquireBrowserSlot: vi.fn().mockResolvedValue({ kind: "acquired", release }) })).rejects.toThrow("page creation failed");
    expect({ browser: browser.close.mock.calls.length, browserSlot: release.mock.calls.length }).toEqual({ browser: 1, browserSlot: 1 });
  });
  it("returns throttled without connecting when shared browser capacity is unavailable", async () => {
    const connect = vi.fn();
    await expect(open({ connect, acquireBrowserSlot: vi.fn().mockResolvedValue({ kind: "throttled" }) })).resolves.toEqual({ status: "throttled" });
    expect(connect).not.toHaveBeenCalled();
  });
  it("rejects non-loopback CDP before acquiring capacity or connecting", async () => {
    const connect = vi.fn();
    const acquireBrowserSlot = vi.fn();
    await expect(createScrapeTimeAutoLoginBrowserOpener({ trustedLoginUrl: POPULAR_LOGIN_URL, connect, acquireBrowserSlot })("popular", "http://10.0.0.5:9222")).rejects.toThrow("loopback");
    expect(acquireBrowserSlot).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });
  it("cleans up the page, browser, and slot after trusted navigation rejects", async () => {
    const release = vi.fn().mockResolvedValue(undefined);
    const rawCloseDetail = "CDP ws://operator:secret@127.0.0.1:9222";
    const failures = vi.fn().mockResolvedValue(undefined);
    const page = makeCdpPage();
    page.goto.mockRejectedValue(new Error("navigation failed"));
    page.close.mockRejectedValue(new Error(rawCloseDetail));
    const browser = makeBrowser(page);
    await expect(open({ connect: vi.fn().mockResolvedValue(browser), acquireBrowserSlot: vi.fn().mockResolvedValue({ kind: "acquired", release }), cleanupTimeoutMs: CLEANUP_TIMEOUT_MS, recordCleanupFailure: failures })).rejects.toThrow("navigation failed");
    expect(cleanupCallCounts(page, browser, release)).toEqual({ page: 1, browser: 1, browserSlot: 1 });
    expect(failures).toHaveBeenCalledWith({ bankCode: "popular", failure: "page_close_failed" });
    expect(JSON.stringify(failures.mock.calls)).not.toContain(rawCloseDetail);
  });
  const cleanupFailureCases = [
    { description: "slot never settles", failure: "browser_slot_release_failed", resource: "slot", mode: "never settles" },
    { description: "page never settles", failure: "page_close_failed", resource: "page", mode: "never settles" },
    { description: "browser rejects", failure: "browser_close_failed", resource: "browser", mode: "rejects" },
    { description: "browser never settles", failure: "browser_close_failed", resource: "browser", mode: "never settles" },
  ] as const;
  it.each(cleanupFailureCases)("records a safe $description cleanup failure", async ({ failure, resource, mode }) => {
    const rawCdpDetail = "CDP ws://operator:secret@127.0.0.1:9222";
    const failures = vi.fn().mockResolvedValue(undefined);
    const never = () => new Promise<void>(() => undefined);
    const page = { ...makeCdpPage(), close: vi.fn(resource === "page" ? never : () => Promise.resolve()) };
    const browser = makeBrowser(page);
    browser.close.mockImplementation(() => resource !== "browser" ? Promise.resolve() : mode === "rejects" ? Promise.reject(new Error(rawCdpDetail)) : never());
    const release = vi.fn(resource === "slot" ? never : () => Promise.resolve());
    const owned = await openReadyBrowser({ connect: vi.fn().mockResolvedValue(browser), acquireBrowserSlot: vi.fn().mockResolvedValue({ kind: "acquired", release }), cleanupTimeoutMs: CLEANUP_TIMEOUT_MS, recordCleanupFailure: failures });
    await owned.close();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(failures).toHaveBeenCalledWith({ bankCode: "popular", failure });
    expect(JSON.stringify(failures.mock.calls)).not.toContain(rawCdpDetail);
  });

  it("closes each owned resource once when close is called repeatedly", async () => {
    const page = makeCdpPage();
    const browser = makeBrowser(page);
    const release = vi.fn().mockResolvedValue(undefined);
    const owned = await openReadyBrowser({ connect: vi.fn().mockResolvedValue(browser), acquireBrowserSlot: vi.fn().mockResolvedValue({ kind: "acquired", release }) });
    await owned.close();
    await owned.close();

    expect(cleanupCallCounts(page, browser, release)).toEqual({ page: 1, browser: 1, browserSlot: 1 });
  });
  const pageSetupTimeoutCases = [
    { description: "newPage remains pending", stage: "newPage", expectedGotoCalls: 0, cleanupBeforeResolution: { page: 0, browser: 1, browserSlot: 1 } },
    { description: "trusted goto remains pending", stage: "goto", expectedGotoCalls: 1, cleanupBeforeResolution: { page: 1, browser: 1, browserSlot: 1 } },
  ] as const;
  it.each(pageSetupTimeoutCases)("bounds page setup when $description past the timeout", async ({ stage, expectedGotoCalls, cleanupBeforeResolution }) => {
    vi.useFakeTimers();
    try {
      const { page, browser, release, resolveSetup } = makeDeferredPageSetup(stage);
      const failures = vi.fn().mockResolvedValue(undefined);
      page.close.mockImplementation(() => new Promise<void>(() => undefined));
      const opening = open({ connect: vi.fn().mockResolvedValue(browser),
        acquireBrowserSlot: vi.fn().mockResolvedValue({ kind: "acquired", release }), pageSetupTimeoutMs: PAGE_SETUP_TIMEOUT_MS,
        cleanupTimeoutMs: CLEANUP_TIMEOUT_MS, recordCleanupFailure: failures });
      const rejected = expect(opening).rejects.toThrow("Timed out while preparing the trusted bank login page");
      await vi.advanceTimersByTimeAsync(PAGE_SETUP_TIMEOUT_MS);
      await rejected;
      expect(cleanupCallCounts(page, browser, release)).toEqual(cleanupBeforeResolution);
      resolveSetup();
      await vi.advanceTimersByTimeAsync(0);
      expect(cleanupCallCounts(page, browser, release)).toEqual({ page: 1, browser: 1, browserSlot: 1 });
      expect(page.goto).toHaveBeenCalledTimes(expectedGotoCalls);
      await vi.advanceTimersByTimeAsync(CLEANUP_TIMEOUT_MS);
      expect(failures).toHaveBeenCalledWith({ bankCode: "popular", failure: "page_close_failed" });
    } finally {
      vi.useRealTimers();
    }
  });
});
