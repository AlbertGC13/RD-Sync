import { describe, expect, it, vi } from "vitest";

import { LOGIN_MUTATION_GUARD_ERROR_SUMMARIES, LoginMutationGuard, LoginMutationGuardError, type BankPortalConfig, type LoginMutationPage } from "./login-mutation-guard";

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
