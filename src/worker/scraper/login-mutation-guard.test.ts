import { describe, expect, it, vi } from "vitest";

import {
  LoginMutationGuard,
  LoginMutationGuardError,
  LOGIN_MUTATION_GUARD_ERROR_SUMMARIES,
  type BankPortalConfig,
  type LoginMutationPage,
} from "./login-mutation-guard";

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
    async currentUrl() {
      return url;
    },
    async hasVisibleSelector(selector) {
      return visibleSelectors.includes(selector);
    },
  };
}

async function guardedSubmit(
  guard: LoginMutationGuard,
  page: LoginMutationPage,
  fill: () => void,
  submit: () => void,
): Promise<void> {
  await guard.beforeFill(page);
  fill();
  await guard.beforeSubmit(page);
  submit();
}

describe("LoginMutationGuard", () => {
  it.each([
    ["rejects http portal URLs", "http://ib.bpd.com.do/login"],
    ["rejects subdomain lookalikes", "https://ib.bpd.com.do.evil.com/login"],
    ["rejects userinfo tricks", "https://ib.bpd.com.do@evil.com/login"],
    ["rejects port mismatches", "https://ib.bpd.com.do:8443/login"],
    ["rejects paths outside the allowlist", "https://ib.bpd.com.do/dashboard"],
  ])("%s", async (_caseName, url) => {
    const guard = new LoginMutationGuard(portalConfig);

    await expect(guard.assertLoginPage(makePage(url))).rejects.toMatchObject({
      outcome: "needs_admin_action",
      safeSummary: LOGIN_MUTATION_GUARD_ERROR_SUMMARIES.UNAUTHORIZED_LOGIN_PAGE,
    });
  });

  it("rejects malformed URLs with a fixed safe summary", async () => {
    const guard = new LoginMutationGuard(portalConfig);

    await expect(guard.assertLoginPage(makePage("not a url with secret=password"))).rejects.toMatchObject({
      safeSummary: LOGIN_MUTATION_GUARD_ERROR_SUMMARIES.MALFORMED_PORTAL_URL,
    });
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

  it("re-checks before submit and catches redirect/navigation after fill", async () => {
    let currentUrl = "https://ib.bpd.com.do/login";
    const visibleSelectors = new Set<string>(allLoginControlSelectors);
    const page: LoginMutationPage = {
      async currentUrl() { return currentUrl; },
      async hasVisibleSelector(selector) { return visibleSelectors.has(selector); },
    };
    const guard = new LoginMutationGuard(portalConfig);
    const fill = vi.fn(() => {
      currentUrl = "https://evil.com/login";
    });
    const submit = vi.fn();

    await expect(guardedSubmit(guard, page, fill, submit)).rejects.toMatchObject({
      safeSummary: LOGIN_MUTATION_GUARD_ERROR_SUMMARIES.UNAUTHORIZED_LOGIN_PAGE,
    });

    expect(fill).toHaveBeenCalledOnce();
    expect(submit).not.toHaveBeenCalled();
  });

  it("blocks incompatible pre-submit flows before caller mutations run", async () => {
    const page = makePage("https://ib.bpd.com.do/login", ["[data-corporate-token]"]);
    const guard = new LoginMutationGuard(portalConfig);
    const fill = vi.fn();
    const submit = vi.fn();

    await expect(guardedSubmit(guard, page, fill, submit)).rejects.toMatchObject({
      outcome: "needs_admin_action",
      safeSummary: LOGIN_MUTATION_GUARD_ERROR_SUMMARIES.INCOMPATIBLE_FLOW,
    });

    expect(fill).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it.each([
    ["username", [portalConfig.passwordSelector, portalConfig.submitSelector], 0],
    ["password", [portalConfig.usernameSelector, portalConfig.submitSelector], 0],
    ["submit", credentialControlSelectors, 0],
  ] as const)("blocks guarded submission when the required %s control is missing", async (_controlName, selectors, fillCalls) => {
    const page = makePage("https://ib.bpd.com.do/login", selectors);
    const guard = new LoginMutationGuard(portalConfig);
    const fill = vi.fn();
    const submit = vi.fn();

    await expect(guardedSubmit(guard, page, fill, submit)).rejects.toMatchObject({
      outcome: "needs_admin_action",
      reason: "missing_required_login_control",
      safeSummary: LOGIN_MUTATION_GUARD_ERROR_SUMMARIES.MISSING_REQUIRED_LOGIN_CONTROL,
    });

    expect(fill).toHaveBeenCalledTimes(fillCalls);
    expect(submit).not.toHaveBeenCalled();
  });

  it("blocks MFA-protected pages before caller mutations run", async () => {
    const page = makePage("https://ib.bpd.com.do/login", ["[data-mfa]"]);
    const guard = new LoginMutationGuard(portalConfig);
    const fill = vi.fn();
    const submit = vi.fn();

    await expect(guardedSubmit(guard, page, fill, submit)).rejects.toMatchObject({
      outcome: "needs_admin_action",
      reason: "protected_flow",
      safeSummary: LOGIN_MUTATION_GUARD_ERROR_SUMMARIES.PROTECTED_FLOW,
    });

    expect(fill).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it("does not authorize submit when an MFA indicator appears after fill", async () => {
    const visibleSelectors = new Set<string>(allLoginControlSelectors);
    const page: LoginMutationPage = {
      async currentUrl() { return "https://ib.bpd.com.do/login"; },
      async hasVisibleSelector(selector) { return visibleSelectors.has(selector); },
    };
    const guard = new LoginMutationGuard(portalConfig);
    const fill = vi.fn(() => {
      visibleSelectors.add("[data-mfa]");
    });
    const submit = vi.fn();

    await expect(guardedSubmit(guard, page, fill, submit)).rejects.toMatchObject({
      reason: "protected_flow",
      safeSummary: LOGIN_MUTATION_GUARD_ERROR_SUMMARIES.PROTECTED_FLOW,
    });

    expect(fill).toHaveBeenCalledOnce();
    expect(submit).not.toHaveBeenCalled();
  });

  it("validates the login page when assertCompatiblePreSubmit is called directly", async () => {
    const guard = new LoginMutationGuard(portalConfig);

    await expect(guard.assertCompatiblePreSubmit(makePage("https://evil.com/login"))).rejects.toMatchObject({
      safeSummary: LOGIN_MUTATION_GUARD_ERROR_SUMMARIES.UNAUTHORIZED_LOGIN_PAGE,
    });
  });

  it("validates required pre-submit controls when assertCompatiblePreSubmit is called directly", async () => {
    const page = makePage("https://ib.bpd.com.do/login", credentialControlSelectors);
    const guard = new LoginMutationGuard(portalConfig);

    await expect(guard.assertCompatiblePreSubmit(page)).rejects.toMatchObject({
      safeSummary: LOGIN_MUTATION_GUARD_ERROR_SUMMARIES.MISSING_REQUIRED_LOGIN_CONTROL,
    });
  });

  it("uses typed errors with fixed safe summaries", async () => {
    const guard = new LoginMutationGuard(portalConfig);
    const rejection = guard.beforeSubmit(makePage("https://evil.com/login"));

    await expect(rejection).rejects.toBeInstanceOf(LoginMutationGuardError);
    await expect(rejection).rejects.toMatchObject({
      safeSummary: LOGIN_MUTATION_GUARD_ERROR_SUMMARIES.UNAUTHORIZED_LOGIN_PAGE,
    });
  });

  it.each([
    ["currentUrl", {
      async currentUrl(): Promise<string> { throw new Error("browser leaked https://evil.example/login?password=secret"); },
      async hasVisibleSelector(): Promise<boolean> { return true; },
    }],
    ["hasVisibleSelector", {
      async currentUrl(): Promise<string> { return "https://ib.bpd.com.do/login"; },
      async hasVisibleSelector(selector: string): Promise<boolean> { throw new Error(`selector leaked ${selector} with internal diagnostics`); },
    }],
  ] as const)("translates %s failures to a fixed safe guard error", async (_operation, page) => {
    const guard = new LoginMutationGuard(portalConfig);
    const rejection = guard.beforeFill(page);

    await expect(rejection).rejects.toBeInstanceOf(LoginMutationGuardError);
    await expect(rejection).rejects.toMatchObject({
      outcome: "needs_admin_action",
      reason: "portal_state_unavailable",
      safeSummary: LOGIN_MUTATION_GUARD_ERROR_SUMMARIES.PORTAL_STATE_UNAVAILABLE,
    });
    await expect(rejection).rejects.toThrow(LOGIN_MUTATION_GUARD_ERROR_SUMMARIES.PORTAL_STATE_UNAVAILABLE);
  });
});
