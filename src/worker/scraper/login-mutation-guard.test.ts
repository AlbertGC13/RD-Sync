import { describe, expect, it, vi } from "vitest";

import { LOGIN_MUTATION_GUARD_ERROR_SUMMARIES, MIN_PROTECTED_STATE_DETECTION_WINDOW_MS, LoginMutationGuard, LoginMutationGuardError, type BankPortalConfig, type LoginMutationPage } from "./login-mutation-guard";

const portalConfig: BankPortalConfig = {
  bankCode: "popular",
  baseUrl: "https://ib.bpd.com.do",
  loginPathAllowlist: ["/login"],
  usernameSelector: "#username",
  passwordSelector: "#password",
  submitSelector: "button[type='submit']",
  mfaIndicatorSelector: "[data-mfa]",
  incompatibleFlowSelector: "[data-corporate-token]",
  dashboardPathIndicator: "/dashboard",
};

const credentialControlSelectors = [portalConfig.usernameSelector, portalConfig.passwordSelector] as const;
const allLoginControlSelectors = [...credentialControlSelectors, portalConfig.submitSelector] as const;

function makePage(url: string, visibleSelectors: readonly string[] = []): LoginMutationPage {
  return {
    async currentUrl() { return url; },
    async hasVisibleSelector(selector) { return visibleSelectors.includes(selector); },
  };
}

async function guardedSubmit(guard: LoginMutationGuard, page: LoginMutationPage, fill: () => void | Promise<void>, submit: () => void): Promise<void> {
  await guard.assertMutationAuthorized(page);
  await fill();
  await guard.assertMutationAuthorized(page);
  submit();
}

describe("LoginMutationGuard absence probes", () => {
  // Absence probes resolve by EXPIRING, so every happy-path pass pays the full
  // window. That cost is accepted: it is the interval in which a protected flow
  // can still be caught, and it is not negotiable per call site.
  function makeTimeoutRecordingPage(url: string, visibleSelectors: readonly string[]) {
    const probes: Array<{ selector: string; timeoutMs?: number }> = [];
    const page: LoginMutationPage = {
      async currentUrl() { return url; },
      async hasVisibleSelector(selector, timeoutMs) {
        probes.push({ selector, timeoutMs });
        return visibleSelectors.includes(selector);
      },
    };
    return { page, probes };
  }

  // Not merely the default — the only option. Callers cannot trade detection
  // latency for speed at a mutation boundary, because the parameter that once
  // allowed it no longer exists.
  it("gives every caller the clamped detection window", async () => {
    const { page, probes } = makeTimeoutRecordingPage("https://ib.bpd.com.do/login", allLoginControlSelectors);

    await new LoginMutationGuard(portalConfig).assertMutationAuthorized(page);

    const absenceProbes = probes.filter((probe) =>
      probe.selector === portalConfig.mfaIndicatorSelector || probe.selector === portalConfig.incompatibleFlowSelector);
    expect(absenceProbes).toHaveLength(2);
    for (const probe of absenceProbes) expect(probe.timeoutMs).toBe(MIN_PROTECTED_STATE_DETECTION_WINDOW_MS);
  });

  it("keeps the page default wait for required controls, which must be given time to render", async () => {
    const { page, probes } = makeTimeoutRecordingPage("https://ib.bpd.com.do/login", allLoginControlSelectors);

    await new LoginMutationGuard(portalConfig).assertMutationAuthorized(page);

    const controlProbes = probes.filter((probe) => allLoginControlSelectors.includes(probe.selector as (typeof allLoginControlSelectors)[number]));
    expect(controlProbes.length).toBeGreaterThan(0);
    for (const probe of controlProbes) expect(probe.timeoutMs).toBeUndefined();
  });

  // The wait is not idle time — it IS the detection window. An overlay that
  // renders seconds after the form is exactly what it exists to catch.
  it("catches an overlay that renders late but inside the detection window", async () => {
    const page: LoginMutationPage = {
      async currentUrl() { return "https://ib.bpd.com.do/login"; },
      async hasVisibleSelector(selector, timeoutMs) {
        if (allLoginControlSelectors.includes(selector as (typeof allLoginControlSelectors)[number])) return true;
        if (selector !== portalConfig.incompatibleFlowSelector) return false;
        // Stands in for an overlay that renders a few seconds after the form: a
        // wait shorter than the window would return false and miss it.
        return (timeoutMs ?? 0) >= MIN_PROTECTED_STATE_DETECTION_WINDOW_MS;
      },
    };

    // The very first boundary rejects, so no credential is ever written.
    await expect(new LoginMutationGuard(portalConfig).assertMutationAuthorized(page))
      .rejects.toBeInstanceOf(LoginMutationGuardError);
  });

  it("keeps the full detection window post-submit, where the bank's MFA screen legitimately appears", async () => {
    const { page, probes } = makeTimeoutRecordingPage("https://ib.bpd.com.do/dashboard", []);

    await new LoginMutationGuard(portalConfig).assertNoProtectedOrIncompatibleState(page);

    expect(probes).toHaveLength(2);
    for (const probe of probes) expect(probe.timeoutMs).toBe(MIN_PROTECTED_STATE_DETECTION_WINDOW_MS);
  });

  // The floor is the guard's, not the page's: a page that declares a narrower
  // window cannot shrink the protection, but may widen it.
  it.each([
    [undefined, MIN_PROTECTED_STATE_DETECTION_WINDOW_MS],
    [1_000, MIN_PROTECTED_STATE_DETECTION_WINDOW_MS],
    [Number.NaN, MIN_PROTECTED_STATE_DETECTION_WINDOW_MS],
    [Number.POSITIVE_INFINITY, MIN_PROTECTED_STATE_DETECTION_WINDOW_MS],
    [-1, MIN_PROTECTED_STATE_DETECTION_WINDOW_MS],
    [MIN_PROTECTED_STATE_DETECTION_WINDOW_MS * 3, MIN_PROTECTED_STATE_DETECTION_WINDOW_MS * 3],
  ])("clamps a page-declared detection window of %j to %j", async (declared, expected) => {
    const { page, probes } = makeTimeoutRecordingPage("https://ib.bpd.com.do/dashboard", []);
    const declaringPage: LoginMutationPage = { ...page, protectedStateDetectionWindowMs: declared };

    await new LoginMutationGuard(portalConfig).assertNoProtectedOrIncompatibleState(declaringPage);

    expect(probes).toHaveLength(2);
    for (const probe of probes) expect(probe.timeoutMs).toBe(expected);
  });

  it("detects an MFA indicator that is already visible", async () => {
    const { page } = makeTimeoutRecordingPage("https://ib.bpd.com.do/login", [...allLoginControlSelectors, portalConfig.mfaIndicatorSelector]);

    await expect(new LoginMutationGuard(portalConfig).assertMutationAuthorized(page)).rejects.toBeInstanceOf(LoginMutationGuardError);
  });
});

describe("LoginMutationGuard", () => {
  it.each([
    ["rejects http portal URLs", "http://ib.bpd.com.do/login"],
    ["rejects subdomain lookalikes", "https://ib.bpd.com.do.evil.com/login"],
    ["rejects userinfo tricks", "https://ib.bpd.com.do@evil.com/login"],
    ["rejects userinfo on the allowed origin", "https://evil.example@ib.bpd.com.do/login"],
    ["rejects port mismatches", "https://ib.bpd.com.do:8443/login"],
    ["rejects paths outside the allowlist", "https://ib.bpd.com.do/dashboard"],
  ])("%s", async (_caseName, url) => {
    const guard = new LoginMutationGuard(portalConfig);

    await expect(guard.assertMutationAuthorized(makePage(url, allLoginControlSelectors))).rejects.toMatchObject({
      outcome: "needs_admin_action",
      safeSummary: LOGIN_MUTATION_GUARD_ERROR_SUMMARIES.UNAUTHORIZED_LOGIN_PAGE,
    });
  });

  it("rejects malformed URLs with a typed fixed safe error", async () => {
    const guard = new LoginMutationGuard(portalConfig);
    const rejection = guard.assertMutationAuthorized(makePage("not a url with secret=password", allLoginControlSelectors));

    await expect(rejection).rejects.toBeInstanceOf(LoginMutationGuardError);
    await expect(rejection).rejects.toMatchObject({ message: LOGIN_MUTATION_GUARD_ERROR_SUMMARIES.MALFORMED_PORTAL_URL, reason: "malformed_url", safeSummary: LOGIN_MUTATION_GUARD_ERROR_SUMMARIES.MALFORMED_PORTAL_URL });
  });

  it.each([
    ["baseUrl userinfo", { ...portalConfig, baseUrl: "https://evil.example@ib.bpd.com.do/login" }, LOGIN_MUTATION_GUARD_ERROR_SUMMARIES.MALFORMED_PORTAL_URL],
    ["missing username selector", { ...portalConfig, usernameSelector: undefined }, LOGIN_MUTATION_GUARD_ERROR_SUMMARIES.PORTAL_STATE_UNAVAILABLE],
    ["missing password selector", { ...portalConfig, passwordSelector: undefined }, LOGIN_MUTATION_GUARD_ERROR_SUMMARIES.PORTAL_STATE_UNAVAILABLE],
    ["missing submit selector", { ...portalConfig, submitSelector: undefined }, LOGIN_MUTATION_GUARD_ERROR_SUMMARIES.PORTAL_STATE_UNAVAILABLE],
    ["blank username selector", { ...portalConfig, usernameSelector: " \t " }, LOGIN_MUTATION_GUARD_ERROR_SUMMARIES.PORTAL_STATE_UNAVAILABLE],
    ["blank password selector", { ...portalConfig, passwordSelector: "\n" }, LOGIN_MUTATION_GUARD_ERROR_SUMMARIES.PORTAL_STATE_UNAVAILABLE],
    ["blank submit selector", { ...portalConfig, submitSelector: "" }, LOGIN_MUTATION_GUARD_ERROR_SUMMARIES.PORTAL_STATE_UNAVAILABLE],
    ["missing MFA detector", { ...portalConfig, mfaIndicatorSelector: undefined }, LOGIN_MUTATION_GUARD_ERROR_SUMMARIES.PORTAL_STATE_UNAVAILABLE],
    ["missing incompatible-flow detector", { ...portalConfig, incompatibleFlowSelector: undefined }, LOGIN_MUTATION_GUARD_ERROR_SUMMARIES.PORTAL_STATE_UNAVAILABLE],
    ["blank MFA detector", { ...portalConfig, mfaIndicatorSelector: " \t " }, LOGIN_MUTATION_GUARD_ERROR_SUMMARIES.PORTAL_STATE_UNAVAILABLE],
    ["blank incompatible-flow detector", { ...portalConfig, incompatibleFlowSelector: "\n" }, LOGIN_MUTATION_GUARD_ERROR_SUMMARIES.PORTAL_STATE_UNAVAILABLE],
    ["missing login path allowlist", { ...portalConfig, loginPathAllowlist: undefined }, LOGIN_MUTATION_GUARD_ERROR_SUMMARIES.PORTAL_STATE_UNAVAILABLE],
    ["empty login path allowlist", { ...portalConfig, loginPathAllowlist: [] }, LOGIN_MUTATION_GUARD_ERROR_SUMMARIES.PORTAL_STATE_UNAVAILABLE],
    ["blank login path allowlist entry", { ...portalConfig, loginPathAllowlist: [""] }, LOGIN_MUTATION_GUARD_ERROR_SUMMARIES.PORTAL_STATE_UNAVAILABLE],
    ["whitespace login path allowlist entry", { ...portalConfig, loginPathAllowlist: [" \t "] }, LOGIN_MUTATION_GUARD_ERROR_SUMMARIES.PORTAL_STATE_UNAVAILABLE],
  ] as const)("fails closed when config has %s", (_caseName, config, safeSummary) => {
    expect(() => new LoginMutationGuard(config as unknown as BankPortalConfig)).toThrow(safeSummary);
  });

  it("runs fill and submit when the login URL and controls are authorized", async () => {
    const page = makePage("https://ib.bpd.com.do/login", allLoginControlSelectors);
    const guard = new LoginMutationGuard(portalConfig);
    const fill = vi.fn();
    const submit = vi.fn();

    await expect(guardedSubmit(guard, page, fill, submit)).resolves.toBeUndefined();

    expect(fill).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledOnce();
  });

  it("checks controls and protected states before reading the authorized URL at the mutation boundary", async () => {
    const events: string[] = [];
    const page: LoginMutationPage = {
      async currentUrl() {
        events.push("url");
        return "https://ib.bpd.com.do/login";
      },
      async hasVisibleSelector(selector) {
        events.push(`selector:${selector}`);
        return allLoginControlSelectors.includes(selector as (typeof allLoginControlSelectors)[number]);
      },
    };

    await expect(new LoginMutationGuard(portalConfig).assertMutationAuthorized(page)).resolves.toBeUndefined();

    expect(events).toEqual([
      "selector:#username",
      "selector:#password",
      "selector:button[type='submit']",
      "selector:[data-mfa]",
      "selector:[data-corporate-token]",
      "url",
    ]);
  });

  it("awaits async fill before submit re-checks and catches navigation drift", async () => {
    let currentUrl = "https://ib.bpd.com.do/login";
    const events: string[] = [];
    const visibleSelectors = new Set<string>(allLoginControlSelectors);
    const page: LoginMutationPage = {
      async currentUrl() { events.push(`url:${currentUrl}`); return currentUrl; },
      async hasVisibleSelector(selector) { return visibleSelectors.has(selector); },
    };
    const guard = new LoginMutationGuard(portalConfig);
    const fill = vi.fn(async () => {
      events.push("fill:start");
      await Promise.resolve();
      currentUrl = "https://evil.com/login";
      events.push("fill:end");
    });
    const submit = vi.fn();

    await expect(guardedSubmit(guard, page, fill, submit)).rejects.toMatchObject({
      safeSummary: LOGIN_MUTATION_GUARD_ERROR_SUMMARIES.UNAUTHORIZED_LOGIN_PAGE,
    });

    expect(fill).toHaveBeenCalledOnce();
    expect(submit).not.toHaveBeenCalled();
    expect(events).toEqual(["url:https://ib.bpd.com.do/login", "fill:start", "fill:end", "url:https://evil.com/login"]);
  });

  it.each([
    ["incompatible pre-submit flows", ["[data-corporate-token]"], "incompatible_flow", LOGIN_MUTATION_GUARD_ERROR_SUMMARIES.INCOMPATIBLE_FLOW],
    ["MFA-protected pages", ["[data-mfa]"], "protected_flow", LOGIN_MUTATION_GUARD_ERROR_SUMMARIES.PROTECTED_FLOW],
  ] as const)("blocks %s before caller mutations run", async (_caseName, selectors, reason, safeSummary) => {
    const page = makePage("https://ib.bpd.com.do/login", [...allLoginControlSelectors, ...selectors]);
    const guard = new LoginMutationGuard(portalConfig);
    const fill = vi.fn();
    const submit = vi.fn();

    await expect(guardedSubmit(guard, page, fill, submit)).rejects.toMatchObject({
      outcome: "needs_admin_action",
      reason,
      safeSummary,
    });

    expect(fill).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it.each([
    ["username", [portalConfig.passwordSelector, portalConfig.submitSelector]],
    ["password", [portalConfig.usernameSelector, portalConfig.submitSelector]],
    ["submit", credentialControlSelectors],
  ] as const)("blocks guarded submission when the required %s control is missing", async (_controlName, selectors) => {
    const page = makePage("https://ib.bpd.com.do/login", selectors);
    const guard = new LoginMutationGuard(portalConfig);
    const fill = vi.fn();
    const submit = vi.fn();

    await expect(guardedSubmit(guard, page, fill, submit)).rejects.toMatchObject({
      outcome: "needs_admin_action",
      reason: "missing_required_login_control",
      safeSummary: LOGIN_MUTATION_GUARD_ERROR_SUMMARIES.MISSING_REQUIRED_LOGIN_CONTROL,
    });

    expect(fill).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it.each([
    ["MFA indicator", "[data-mfa]", "protected_flow", LOGIN_MUTATION_GUARD_ERROR_SUMMARIES.PROTECTED_FLOW],
    ["incompatible flow", "[data-corporate-token]", "incompatible_flow", LOGIN_MUTATION_GUARD_ERROR_SUMMARIES.INCOMPATIBLE_FLOW],
  ] as const)("does not authorize submit when %s appears after async fill", async (_caseName, selector, reason, safeSummary) => {
    const visibleSelectors = new Set<string>(allLoginControlSelectors);
    const page: LoginMutationPage = {
      async currentUrl() { return "https://ib.bpd.com.do/login"; },
      async hasVisibleSelector(selector) { return visibleSelectors.has(selector); },
    };
    const guard = new LoginMutationGuard(portalConfig);
    const fill = vi.fn(async () => {
      await Promise.resolve();
      visibleSelectors.add(selector);
    });
    const submit = vi.fn();

    await expect(guardedSubmit(guard, page, fill, submit)).rejects.toMatchObject({
      reason,
      safeSummary,
    });

    expect(fill).toHaveBeenCalledOnce();
    expect(submit).not.toHaveBeenCalled();
  });

  it("rejects an unauthorized login page through the canonical mutation authorization API", async () => {
    const guard = new LoginMutationGuard(portalConfig);

    await expect(guard.assertMutationAuthorized(makePage("https://evil.com/login", allLoginControlSelectors))).rejects.toMatchObject({
      safeSummary: LOGIN_MUTATION_GUARD_ERROR_SUMMARIES.UNAUTHORIZED_LOGIN_PAGE,
    });
  });

  it("rejects missing required controls through the canonical mutation authorization API", async () => {
    const page = makePage("https://ib.bpd.com.do/login", credentialControlSelectors);
    const guard = new LoginMutationGuard(portalConfig);

    await expect(guard.assertMutationAuthorized(page)).rejects.toMatchObject({
      safeSummary: LOGIN_MUTATION_GUARD_ERROR_SUMMARIES.MISSING_REQUIRED_LOGIN_CONTROL,
    });
  });

  it("uses typed errors with fixed safe summaries", async () => {
    const guard = new LoginMutationGuard(portalConfig);
    const rejection = guard.assertMutationAuthorized(makePage("https://evil.com/login", allLoginControlSelectors));

    await expect(rejection).rejects.toBeInstanceOf(LoginMutationGuardError);
    await expect(rejection).rejects.toMatchObject({
      safeSummary: LOGIN_MUTATION_GUARD_ERROR_SUMMARIES.UNAUTHORIZED_LOGIN_PAGE,
    });
  });

  it.each([
    ["currentUrl", {
      async currentUrl(): Promise<string> { throw new Error("browser leaked https://evil.example/login?password=secret"); },
      async hasVisibleSelector(selector: string): Promise<boolean> { return allLoginControlSelectors.includes(selector as (typeof allLoginControlSelectors)[number]); },
    }],
    ["hasVisibleSelector", {
      async currentUrl(): Promise<string> { return "https://ib.bpd.com.do/login"; },
      async hasVisibleSelector(selector: string): Promise<boolean> { throw new Error(`selector leaked ${selector} with internal diagnostics`); },
    }],
  ] as const)("translates %s failures to a fixed safe guard error", async (_operation, page) => {
    const guard = new LoginMutationGuard(portalConfig);
    const rejection = guard.assertMutationAuthorized(page);

    await expect(rejection).rejects.toBeInstanceOf(LoginMutationGuardError);
    await expect(rejection).rejects.toMatchObject({
      outcome: "needs_admin_action",
      reason: "portal_state_unavailable",
      safeSummary: LOGIN_MUTATION_GUARD_ERROR_SUMMARIES.PORTAL_STATE_UNAVAILABLE,
    });
    await expect(rejection).rejects.toThrow(LOGIN_MUTATION_GUARD_ERROR_SUMMARIES.PORTAL_STATE_UNAVAILABLE);
  });
});
