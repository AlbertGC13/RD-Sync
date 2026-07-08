import { describe, expect, it, vi } from "vitest";

import { createBankAutoLoginStrategy, type BankAutoLoginPage } from "./auto-login";
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
