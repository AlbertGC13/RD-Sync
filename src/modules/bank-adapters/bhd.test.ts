import { describe, expect, it } from "vitest";
import {
  bhdPersonalAdapter, bhdPersonalScraperProfile,
  bhdPersonalPortalConfig, bhdBankCode,
} from "./bhd";

describe("BHD Personal adapter identity + skeleton contract", () => {
  it("bankCode=bhd, portalVariant=personal, auto-login not implemented", () => {
    expect(bhdBankCode).toBe("bhd");
    expect(bhdPersonalAdapter.bankCode).toBe("bhd");
    expect(bhdPersonalAdapter.portalVariant).toBe("personal");
    expect(() => bhdPersonalAdapter.createAutoLoginStrategy()).toThrow(/not implemented/i);
  });

  it("stub scraper returns needs_admin_action with exact safeErrorSummary", async () => {
    const r = await bhdPersonalAdapter.createScraper().collect();
    expect(r.status).toBe("needs_admin_action");
    expect(r.movements).toEqual([]);
    expect(r.safeErrorSummary).toBe("BHD Personal adapter is a skeleton");
  });

  it("stub session checker returns expired (fail-safe) with exact safeSummary", async () => {
    const r = await bhdPersonalAdapter.createSessionChecker().check();
    expect(r.status).toBe("expired");
    expect(r.safeSummary).toBe("Bank session expired or requires verification");
  });
});

describe("BHD Personal profile — recon-derived fields", () => {
  it("identity, login, accountFingerprint, loginStrategy, routes", () => {
    expect(bhdPersonalScraperProfile.bankId).toBe("bhd");
    expect(bhdPersonalScraperProfile.portalVariant).toBe("personal");
    expect(bhdPersonalScraperProfile.loginUrl).toBe("https://ibp.bhd.com.do/#/login");
    expect(bhdPersonalScraperProfile.accountFingerprint).toBe("bhd-XXXXXXXXXX");
    expect(bhdPersonalScraperProfile.loginStrategy).toBe("admin-assisted-first-login+remember-browser+cdp-attach");
    expect(bhdPersonalScraperProfile.routes).toEqual({
      dashboard: "#/bhd/dashboard", productDetail: "#/bhd/product-detail",
    });
  });

  it("login selectors, CAPTCHA area, date inputs, transaction table + row + column mapping", () => {
    expect(bhdPersonalScraperProfile.selectors).toMatchObject({
      usernameInput: "input#userName", passwordInput: "input#password",
      captchaArea: "div.field.col-10.mb-2", submitButton: "button[type='submit'].bhd-btn-primary",
      accountCard: "app-account-card", viewMovementsButton: "button.bhd-btn-primary",
      periodDropdown: "div.p-select-dropdown", searchInput: "input[placeholder='Buscar']",
      fromDateInput: "input.p-datepicker-input[placeholder='Fecha inicio']",
      toDateInput: "input.p-datepicker-input[placeholder='Fecha final']",
      transactionTable: "table.p-datatable-table", transactionRow: "tr.body-responsive",
    });
    expect(bhdPersonalScraperProfile.columnMapping).toEqual({
      date: 0, confirmation: 1, description: 2, receipt: 3, debit: 4, credit: 5, balance: 6,
    });
    expect(bhdPersonalScraperProfile.formats).toEqual({ date: "DD/MM/YYYY", amount: "RD$ 1,234.56" });
    expect(bhdPersonalScraperProfile.paginationStrategy).toBe("scroll-stabilize");
  });
});

describe("BHD portal config", () => {
  it("bankCode, baseUrl, CDP env, login allowlist", () => {
    expect(bhdPersonalPortalConfig.bankCode).toBe("bhd");
    expect(bhdPersonalPortalConfig.baseUrl).toBe("https://ibp.bhd.com.do");
    expect(bhdPersonalPortalConfig.loginPathAllowlist).toContain("/#/login");
    expect(bhdPersonalPortalConfig.cdpUrlEnv).toBe("RD_SYNC_BANK_BHD_CDP_URL");
  });
});
