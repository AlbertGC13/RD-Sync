import { describe, expect, it } from "vitest";
import {
  banreservasBankGroupCode,
  banreservasPersonasBankCode,
  banreservasEmpresasBankCode,
  banreservasPersonasPortalVariant,
  banreservasEmpresasPortalVariant,
  banreservasPersonasScraperProfile,
  banreservasEmpresasScraperProfile,
  banreservasPersonasAdapter,
  banreservasEmpresasAdapter,
  banreservasPersonasPortalConfig,
  banreservasEmpresasPortalConfig,
  createBanreservasAutoLoginStrategy,
} from "./banreservas";
import { createBankAdapterRegistry } from "./registry";

describe("Banreservas adapter identity + portal variant disambiguation", () => {
  it("distinct portal-specific bank codes; group code for display", () => {
    expect(banreservasBankGroupCode).toBe("banreservas");
    expect(banreservasPersonasBankCode).toBe("banreservas_personas");
    expect(banreservasEmpresasBankCode).toBe("banreservas_empresas");
    expect(banreservasPersonasAdapter.bankCode).toBe("banreservas_personas");
    expect(banreservasEmpresasAdapter.bankCode).toBe("banreservas_empresas");
    expect(banreservasPersonasAdapter.portalVariant).toBe("personas");
    expect(banreservasEmpresasAdapter.portalVariant).toBe("empresas");
    expect(banreservasPersonasPortalVariant).toBe("personas");
    expect(banreservasEmpresasPortalVariant).toBe("empresas");
  });

  it("adapters have distinct bankCodes — registry-safe (no Map collision)", () => {
    expect(banreservasPersonasAdapter.bankCode).not.toBe(banreservasEmpresasAdapter.bankCode);
    expect(banreservasPersonasAdapter.portalVariant).not.toBe(banreservasEmpresasAdapter.portalVariant);
  });
});

describe("Banreservas stub scrapers — fail-safe skeleton contract", () => {
  it("Personas: needs_admin_action + empty movements + exact safeErrorSummary", async () => {
    const r = await banreservasPersonasAdapter.createScraper().collect();
    expect(r.status).toBe("needs_admin_action");
    expect(r.movements).toEqual([]);
    expect(r.safeErrorSummary).toBe("Banreservas Personas adapter is a skeleton");
  });

  it("Empresas: needs_admin_action + empty movements + exact safeErrorSummary", async () => {
    const r = await banreservasEmpresasAdapter.createScraper().collect();
    expect(r.status).toBe("needs_admin_action");
    expect(r.movements).toEqual([]);
    expect(r.safeErrorSummary).toBe("Banreservas Empresas adapter is a skeleton");
  });
});

describe("Banreservas stub session checkers — fail-safe expired + safe summary", () => {
  it("Personas: expired with safe summary", async () => {
    const r = await banreservasPersonasAdapter.createSessionChecker().check();
    expect(r.status).toBe("expired");
    expect(r.safeSummary).toBe("Bank session expired or requires verification");
  });

  it("Empresas: expired with safe summary", async () => {
    const r = await banreservasEmpresasAdapter.createSessionChecker().check();
    expect(r.status).toBe("expired");
    expect(r.safeSummary).toBe("Bank session expired or requires verification");
  });
});

describe("Banreservas auto-login stub — not implemented", () => {
  it("createBanreservasAutoLoginStrategy throws", () => {
    expect(() => createBanreservasAutoLoginStrategy()).toThrow(/not implemented/i);
  });

  it("Personas + Empresas adapters both throw", () => {
    expect(() => banreservasPersonasAdapter.createAutoLoginStrategy()).toThrow(/not implemented/i);
    expect(() => banreservasEmpresasAdapter.createAutoLoginStrategy()).toThrow(/not implemented/i);
  });
});

describe("Banreservas Personas profile — recon-derived selectors/facts", () => {
  it("identity, login, rootElement, fingerprint, searchMode, inputStrategy", () => {
    expect(banreservasPersonasScraperProfile.bankId).toBe("banreservas_personas");
    expect(banreservasPersonasScraperProfile.portalVariant).toBe("personas");
    expect(banreservasPersonasScraperProfile.loginUrl).toBe(
      "https://tubanco.banreservas.com/TuBancoBanreservas/#/administrationGeneral/login",
    );
    expect(banreservasPersonasScraperProfile.rootElement).toBe("icb-app");
    expect(banreservasPersonasScraperProfile.accountFingerprint).toBe("banreservas-XXXXXXXXXX");
    expect(banreservasPersonasScraperProfile.defaultSearchMode).toBe("current-month");
    expect(banreservasPersonasScraperProfile.inputStrategy).toBe("trusted-click+angular-events");
  });

  it("login selectors + submit inactive class", () => {
    expect(banreservasPersonasScraperProfile.selectors).toMatchObject({
      usernameInput: "input[formControlName='username']#step01",
      passwordInput: "input[formControlName='password']#step02",
      submitLink: "a.ipswich-main-buttons-link.default.big",
      submitInactiveClass: "inactive",
    });
  });

  it("transaction table selectors: row, date, description, reference, debit, balance", () => {
    expect(banreservasPersonasScraperProfile.selectors).toMatchObject({
      transactionRow: "div.rivera_row",
      rowDate: "div.rivera_row_info_legend span.marmaris[data-type='date']",
      rowDescription: "div.rivera_row_info_title span.marmaris[data-type='string']",
      rowReference: "div.rivera_row_info_subtitle span.marmaris[data-type='textResourceKey']",
      rowDebit: "div.rivera_row_simple",
      rowBalance: "div.rivera_row_simple.highlighted",
    });
  });

  it("loadMore pagination, calendar, formats", () => {
    expect(banreservasPersonasScraperProfile.selectors.loadMore).toBe("div.florida_wrapper_loader_default");
    expect(banreservasPersonasScraperProfile.selectors.calendar).toEqual({
      root: "div.memphis-main-block.memphis-main-dayView",
      prevMonth: "a.leftArrow",
      nextMonth: "a.rightArrow",
      dayCell: "a.memphis-day-value",
      todayReset: "a.memphis-day-button-reset",
    });
    expect(banreservasPersonasScraperProfile.formats).toEqual({
      date: "DD/MM/YYYY", amount: "-1,234.56", currencyPrefix: "DOP",
    });
  });
});

describe("Banreservas Empresas profile — recon-derived selectors/facts", () => {
  it("identity, login, landing, framework, inputStrategy", () => {
    expect(banreservasEmpresasScraperProfile.bankId).toBe("banreservas_empresas");
    expect(banreservasEmpresasScraperProfile.portalVariant).toBe("empresas");
    expect(banreservasEmpresasScraperProfile.loginUrl).toBe("https://www.banreservas.com.do/TuBancoEmpresas/Login.aspx");
    expect(banreservasEmpresasScraperProfile.landingUrl).toBe("https://www.banreservas.com.do/TuBancoEmpresas/Default.aspx");
    expect(banreservasEmpresasScraperProfile.framework).toBe("aspnet-webforms+devexpress");
    expect(banreservasEmpresasScraperProfile.inputStrategy).toBe("type+postback");
  });

  it("frames, routes, login selectors", () => {
    expect(banreservasEmpresasScraperProfile.frames).toEqual({ top: "topFrame", left: "leftFrame", main: "mainFrame" });
    expect(banreservasEmpresasScraperProfile.routes).toEqual({
      accounts: "/TuBancoEmpresas/Pages/Accounts/Accounts.aspx",
      statementPdf: "/TuBancoEmpresas/Pages/Accounts/AccountStatusPDF.aspx",
    });
    expect(banreservasEmpresasScraperProfile.selectors).toMatchObject({
      usernameInput: "input#ctl00_MainHolder_LoginView_UserName",
      passwordInput: "input#ctl00_MainHolder_LoginView_Password",
      captchaInput: "input#ctl00_MainHolder_LoginView_tbCaptcha",
      submitButton: "input#ctl00_MainHolder_LoginView_btnLogin",
    });
  });

  it("transaction grid + date query selectors", () => {
    expect(banreservasEmpresasScraperProfile.selectors).toMatchObject({
      accountsGrid: "table#ctl00_MainHolder_AccountGrid_AccountASPxGridView_DXMainTable",
      transactionGrid: "table#ctl00_MainHolder_AccountTransactionGrid_ASPxGridViewTransactions",
      transactionRow: "tr[id*='_DXDataRow'].dxgvDataRow",
      dateFrom: "input#ctl00_MainHolder_period_dateTextBoxDateFrom",
      dateTo: "input#ctl00_MainHolder_period_dateTextBoxDateTo",
      consultarButton: "a#ctl00_MainHolder_period_linkButtonConsultar",
    });
  });

  it("formats: DD/MM/YY (2-digit year), no currency prefix, DOP balance", () => {
    expect(banreservasEmpresasScraperProfile.formats).toEqual({
      date: "DD/MM/YY", amount: "1,234.56", balancePrefix: "DOP",
    });
  });
});

describe("Banreservas portal configs", () => {
  it("Personas: baseUrl, CDP env, profile dir, start URL, selectors, login allowlist", () => {
    expect(banreservasPersonasPortalConfig.bankCode).toBe("banreservas_personas");
    expect(banreservasPersonasPortalConfig.baseUrl).toBe("https://tubanco.banreservas.com");
    expect(banreservasPersonasPortalConfig.loginPathAllowlist).toContain("/#/administrationGeneral/login");
    expect(banreservasPersonasPortalConfig.cdpUrlEnv).toBe("RD_SYNC_BANK_BANRESERVAS_PERSONAS_CDP_URL");
    expect(banreservasPersonasPortalConfig.profileDirEnv).toBe("RD_SYNC_BANK_BANRESERVAS_PERSONAS_PROFILE_DIR");
    expect(banreservasPersonasPortalConfig.startUrlEnv).toBe("RD_SYNC_BANK_BANRESERVAS_PERSONAS_START_URL");
    expect(banreservasPersonasPortalConfig.usernameSelector).toBe("input[formControlName='username']#step01");
    expect(banreservasPersonasPortalConfig.passwordSelector).toBe("input[formControlName='password']#step02");
    expect(banreservasPersonasPortalConfig.submitSelector).toBe("a.ipswich-main-buttons-link.default.big");
    expect(banreservasPersonasPortalConfig.incompatibleFlowSelector).toBeUndefined();
  });

  it("Empresas: baseUrl, CDP env, profile dir, start URL, selectors, login allowlist", () => {
    expect(banreservasEmpresasPortalConfig.bankCode).toBe("banreservas_empresas");
    expect(banreservasEmpresasPortalConfig.baseUrl).toBe("https://www.banreservas.com.do");
    expect(banreservasEmpresasPortalConfig.loginPathAllowlist).toContain("/TuBancoEmpresas/Login.aspx");
    expect(banreservasEmpresasPortalConfig.cdpUrlEnv).toBe("RD_SYNC_BANK_BANRESERVAS_EMPRESAS_CDP_URL");
    expect(banreservasEmpresasPortalConfig.profileDirEnv).toBe("RD_SYNC_BANK_BANRESERVAS_EMPRESAS_PROFILE_DIR");
    expect(banreservasEmpresasPortalConfig.startUrlEnv).toBe("RD_SYNC_BANK_BANRESERVAS_EMPRESAS_START_URL");
    expect(banreservasEmpresasPortalConfig.usernameSelector).toBe("input#ctl00_MainHolder_LoginView_UserName");
    expect(banreservasEmpresasPortalConfig.passwordSelector).toBe("input#ctl00_MainHolder_LoginView_Password");
    expect(banreservasEmpresasPortalConfig.submitSelector).toBe("input#ctl00_MainHolder_LoginView_btnLogin");
    expect(banreservasEmpresasPortalConfig.incompatibleFlowSelector).toBeUndefined();
  });
});

describe("Banreservas skeletons — no registration assumptions", () => {
  it("distinct bankCodes enable future registry registration without Map overwrite", () => {
    const registry = createBankAdapterRegistry([banreservasPersonasAdapter, banreservasEmpresasAdapter], {});

    expect(registry.get("banreservas_personas")).toBe(banreservasPersonasAdapter);
    expect(registry.get("banreservas_empresas")).toBe(banreservasEmpresasAdapter);
    expect(registry.get("banreservas")).toBeUndefined();
    expect(registry.supportedBankCodes()).toEqual(["banreservas_personas", "banreservas_empresas"]);
  });

  it("group code is independent of adapter bankCodes (display/metadata only)", () => {
    expect(banreservasBankGroupCode).toBe("banreservas");
    expect(banreservasBankGroupCode).not.toBe(banreservasPersonasAdapter.bankCode);
    expect(banreservasBankGroupCode).not.toBe(banreservasEmpresasAdapter.bankCode);
  });
});
