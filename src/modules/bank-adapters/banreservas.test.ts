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
  parseBanreservasPersonasDate,
  parseBanreservasPersonasAmount,
  parseBanreservasPersonasTransactionRows,
  parseBanreservasEmpresasDate,
  parseBanreservasEmpresasAmount,
  parseBanreservasEmpresasTransactionRows,
} from "./banreservas";
import { createBankAdapterRegistry } from "./registry";
import { banreservasPersonasTransactions } from "./fixtures/banreservas-personas";
import { banreservasEmpresasTransactions } from "./fixtures/banreservas-empresas";

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
    expect(banreservasEmpresasScraperProfile.accountFingerprint).toBe("banreservas-empresas-XXXXXXXXXX");
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

// ---------------------------------------------------------------------------
// parseBanreservasPersonasDate — DD/MM/YYYY → ISO 8601 with Santo Domingo offset
// ---------------------------------------------------------------------------

describe("parseBanreservasPersonasDate", () => {
  it("parses DD/MM/YYYY to ISO 8601 with -04:00 offset", () => {
    expect(parseBanreservasPersonasDate("29/06/2026")).toBe("2026-06-29T00:00:00-04:00");
  });

  it("parses zero-padded day and month", () => {
    expect(parseBanreservasPersonasDate("01/01/2025")).toBe("2025-01-01T00:00:00-04:00");
  });

  it("parses 31/12/2024 year boundary", () => {
    expect(parseBanreservasPersonasDate("31/12/2024")).toBe("2024-12-31T00:00:00-04:00");
  });

  it.each([
    ["2026-06-29", "non-DD/MM/YYYY format (ISO)"],
    ["29/06/26", "short year (DD/MM/YY)"],
    ["", "empty string"],
    ["29/13/2026", "impossible month 13"],
    ["32/06/2026", "impossible day 32"],
    ["31/04/2026", "day 31 for 30-day month (April)"],
    ["30/02/2026", "Feb 30"],
    ["29/02/2025", "Feb 29 in non-leap year"],
  ])("throws on %s (%s)", (input) => {
    expect(() => parseBanreservasPersonasDate(input)).toThrow("Invalid Banreservas Personas date format");
  });

  it("accepts Feb 29 in leap year 2024", () => {
    expect(parseBanreservasPersonasDate("29/02/2024")).toBe("2024-02-29T00:00:00-04:00");
  });
});

// ---------------------------------------------------------------------------
// parseBanreservasPersonasAmount — "44,000.00" or "-5,000.00" → { value, direction }
// ---------------------------------------------------------------------------

describe("parseBanreservasPersonasAmount", () => {
  it("parses positive credit amount", () => {
    const r = parseBanreservasPersonasAmount("44,000.00");
    expect(r.value).toBe(44000);
    expect(r.direction).toBe("credit");
  });

  it("parses negative debit amount", () => {
    const r = parseBanreservasPersonasAmount("-5,000.00");
    expect(r.value).toBe(-5000);
    expect(r.direction).toBe("debit");
  });

  it("parses zero amount as credit", () => {
    const r = parseBanreservasPersonasAmount("0.00");
    expect(r.value).toBe(0);
    expect(r.direction).toBe("credit");
  });

  it("parses amount without thousands separator", () => {
    const r = parseBanreservasPersonasAmount("1234.56");
    expect(r.value).toBeCloseTo(1234.56);
    expect(r.direction).toBe("credit");
  });

  it("parses large grouped amount (1,234,567.89)", () => {
    const r = parseBanreservasPersonasAmount("1,234,567.89");
    expect(r.value).toBe(1234567.89);
    expect(r.direction).toBe("credit");
  });

  it.each([
    ["44,00.00", "malformed grouping (2-digit group)"],
    ["4,4,000.00", "malformed grouping (extra comma)"],
    [",100.00", "leading comma"],
    ["100,.00", "trailing comma before decimal"],
    ["1,23.456", "non-standard group size"],
  ])("rejects malformed comma grouping: %s (%s)", (input) => {
    expect(() => parseBanreservasPersonasAmount(input)).toThrow("Invalid Banreservas Personas amount format");
  });

  it.each([
    ["abc", "non-numeric"],
    ["", "empty string"],
    ["--5000", "double negative"],
  ])("throws on %s (%s)", (input) => {
    expect(() => parseBanreservasPersonasAmount(input)).toThrow("Invalid Banreservas Personas amount format");
  });
});

// ---------------------------------------------------------------------------
// parseBanreservasPersonasTransactionRows — fixture round-trip → BankMovement[]
// ---------------------------------------------------------------------------

describe("parseBanreservasPersonasTransactionRows", () => {
  it("parses fixture transactions into BankMovement objects", () => {
    const movements = parseBanreservasPersonasTransactionRows(banreservasPersonasTransactions);
    expect(movements).toHaveLength(2);

    expect(movements[0]).toMatchObject({
      bankId: "banreservas_personas",
      accountFingerprint: "banreservas-XXXXXXXXXX",
      postedAt: "2026-06-29T00:00:00-04:00",
      amount: "44000.00",
      currency: "DOP",
      direction: "credit",
      concept: "TRANSFERENCIA RECIBIDA",
    });
    expect(movements[0].reference).toBe("Nro. transacción: 408900123456 | Número de referencia: 408900123");

    expect(movements[1]).toMatchObject({
      bankId: "banreservas_personas",
      accountFingerprint: "banreservas-XXXXXXXXXX",
      postedAt: "2026-06-28T00:00:00-04:00",
      amount: "5000.00",
      currency: "DOP",
      direction: "debit",
      concept: "TRANSFERENCIA A COMERCIO DEMO",
    });
    expect(movements[1].reference).toBe("Nro. transacción: 408900234567 | Número de referencia: 408900234");
  });

  it("returns empty array for empty input", () => {
    expect(parseBanreservasPersonasTransactionRows([])).toEqual([]);
  });

  it("accepts custom bankId and accountFingerprint overrides", () => {
    const movements = parseBanreservasPersonasTransactionRows(banreservasPersonasTransactions, {
      bankId: "banreservas-custom",
      accountFingerprint: "banreservas-custom-fp",
    });
    expect(movements[0].bankId).toBe("banreservas-custom");
    expect(movements[0].accountFingerprint).toBe("banreservas-custom-fp");
  });

  it("rejects malformed dates in transaction rows", () => {
    expect(() =>
      parseBanreservasPersonasTransactionRows([{ ...banreservasPersonasTransactions[0], date: "2026-06-29" }]),
    ).toThrow("Invalid Banreservas Personas date format");
  });

  it("rejects malformed amounts in transaction rows", () => {
    expect(() =>
      parseBanreservasPersonasTransactionRows([
        { ...banreservasPersonasTransactions[0], debit: "abc", credit: "" },
      ]),
    ).toThrow("Invalid Banreservas Personas amount format");
  });

  it("rejects malformed comma grouping in transaction rows", () => {
    expect(() =>
      parseBanreservasPersonasTransactionRows([
        { ...banreservasPersonasTransactions[0], debit: "", credit: "44,00.00" },
      ]),
    ).toThrow("Invalid Banreservas Personas amount format");
  });

  it("rejects row where both debit and credit are populated", () => {
    expect(() =>
      parseBanreservasPersonasTransactionRows([
        { ...banreservasPersonasTransactions[0], debit: "-5,000.00", credit: "44,000.00" },
      ]),
    ).toThrow("ambiguous");
  });

  it("rejects row where both debit and credit are empty", () => {
    expect(() =>
      parseBanreservasPersonasTransactionRows([
        { ...banreservasPersonasTransactions[0], debit: "", credit: "" },
      ]),
    ).toThrow("missing");
  });

  it("rejects debit column with positive amount (sign/column mismatch)", () => {
    expect(() =>
      parseBanreservasPersonasTransactionRows([
        { ...banreservasPersonasTransactions[0], debit: "5,000.00", credit: "" },
      ]),
    ).toThrow("sign/column mismatch");
  });

  it("rejects credit column with negative amount (sign/column mismatch)", () => {
    expect(() =>
      parseBanreservasPersonasTransactionRows([
        { ...banreservasPersonasTransactions[0], debit: "", credit: "-1,000.00" },
      ]),
    ).toThrow("sign/column mismatch");
  });

  it("normalizes whitespace-only reference to null", () => {
    const movements = parseBanreservasPersonasTransactionRows([
      { ...banreservasPersonasTransactions[0], reference: "   " },
    ]);
    expect(movements[0].reference).toBeNull();
  });

  it("trims whitespace from reference", () => {
    const movements = parseBanreservasPersonasTransactionRows([
      {
        ...banreservasPersonasTransactions[0],
        reference: "  # Nro. transacción : 408900123456 | Número de referencia : 408900123  ",
      },
    ]);
    expect(movements[0].reference).toBe("Nro. transacción: 408900123456 | Número de referencia: 408900123");
  });
});

// ---------------------------------------------------------------------------
// parseBanreservasEmpresasDate — DD/MM/YY (2-digit year) → ISO 8601
// ---------------------------------------------------------------------------

describe("parseBanreservasEmpresasDate", () => {
  it("parses DD/MM/YY to ISO 8601 with -04:00 offset (assumes 2000+)", () => {
    expect(parseBanreservasEmpresasDate("29/06/26")).toBe("2026-06-29T00:00:00-04:00");
  });

  it("parses zero-padded day and month", () => {
    expect(parseBanreservasEmpresasDate("01/01/25")).toBe("2025-01-01T00:00:00-04:00");
  });

  it("parses 31/12/24 year boundary", () => {
    expect(parseBanreservasEmpresasDate("31/12/24")).toBe("2024-12-31T00:00:00-04:00");
  });

  it("parses 01/01/00 as 2000", () => {
    expect(parseBanreservasEmpresasDate("01/01/00")).toBe("2000-01-01T00:00:00-04:00");
  });

  it.each([
    ["2026-06-29", "non-DD/MM/YY format (ISO)"],
    ["29/06/2026", "4-digit year (DD/MM/YYYY)"],
    ["", "empty string"],
    ["29/13/26", "impossible month 13"],
    ["32/06/26", "impossible day 32"],
    ["31/04/26", "day 31 for 30-day month (April)"],
    ["30/02/26", "Feb 30"],
    ["29/02/25", "Feb 29 in non-leap year (2025)"],
  ])("throws on %s (%s)", (input) => {
    expect(() => parseBanreservasEmpresasDate(input)).toThrow("Invalid Banreservas Empresas date format");
  });

  it("accepts Feb 29 in leap year 2024", () => {
    expect(parseBanreservasEmpresasDate("29/02/24")).toBe("2024-02-29T00:00:00-04:00");
  });
});

// ---------------------------------------------------------------------------
// parseBanreservasEmpresasAmount — positive-only, column-based direction
// ---------------------------------------------------------------------------

describe("parseBanreservasEmpresasAmount", () => {
  it("parses positive credit amount", () => {
    const r = parseBanreservasEmpresasAmount("25,000.00");
    expect(r.value).toBe(25000);
    expect(r.direction).toBe("credit");
  });

  it("parses zero amount as credit", () => {
    const r = parseBanreservasEmpresasAmount("0.00");
    expect(r.value).toBe(0);
    expect(r.direction).toBe("credit");
  });

  it("parses amount without thousands separator", () => {
    const r = parseBanreservasEmpresasAmount("1234.56");
    expect(r.value).toBeCloseTo(1234.56);
    expect(r.direction).toBe("credit");
  });

  it("parses large grouped amount (1,234,567.89)", () => {
    const r = parseBanreservasEmpresasAmount("1,234,567.89");
    expect(r.value).toBe(1234567.89);
    expect(r.direction).toBe("credit");
  });

  it.each([
    ["44,00.00", "malformed grouping (2-digit group)"],
    ["4,4,000.00", "malformed grouping (extra comma)"],
    [",100.00", "leading comma"],
    ["100,.00", "trailing comma before decimal"],
    ["1,23.456", "non-standard group size"],
  ])("rejects malformed comma grouping: %s (%s)", (input) => {
    expect(() => parseBanreservasEmpresasAmount(input)).toThrow("Invalid Banreservas Empresas amount format");
  });

  it.each([
    ["abc", "non-numeric"],
    ["", "empty string"],
    ["--5000", "double negative"],
    ["-5,000.00", "negative amount (sign not expected in Empresas)"],
    ["123.456", "more than 2 decimal places"],
  ])("throws on %s (%s)", (input) => {
    expect(() => parseBanreservasEmpresasAmount(input)).toThrow("Invalid Banreservas Empresas amount format");
  });
});

// ---------------------------------------------------------------------------
// parseBanreservasEmpresasTransactionRows — fixture round-trip → BankMovement[]
// ---------------------------------------------------------------------------

describe("parseBanreservasEmpresasTransactionRows", () => {
  it("parses fixture transactions into BankMovement objects", () => {
    const movements = parseBanreservasEmpresasTransactionRows(banreservasEmpresasTransactions);
    expect(movements).toHaveLength(2);

    expect(movements[0]).toMatchObject({
      bankId: "banreservas_empresas",
      accountFingerprint: "banreservas-empresas-XXXXXXXXXX",
      postedAt: "2026-06-29T00:00:00-04:00",
      amount: "25000.00",
      currency: "DOP",
      direction: "credit",
      concept: "DEPOSITO EN EFECTIVO",
      originator: null,
      metadata: null,
    });
    expect(movements[0].reference).toBe("942632990001");

    expect(movements[1]).toMatchObject({
      bankId: "banreservas_empresas",
      accountFingerprint: "banreservas-empresas-XXXXXXXXXX",
      postedAt: "2026-06-28T00:00:00-04:00",
      amount: "193.15",
      currency: "DOP",
      direction: "debit",
      concept: "COBRO IMP DGII 0.15%_TRANS TUB",
      originator: null,
      metadata: null,
    });
    expect(movements[1].reference).toBe("942632990002");

    // Amounts are absolute strings with exactly 2 decimal places.
    for (const m of movements) {
      expect(m.amount).toMatch(/^\d+\.\d{2}$/);
    }
  });

  it("returns empty array for empty input", () => {
    expect(parseBanreservasEmpresasTransactionRows([])).toEqual([]);
  });

  it("accepts custom bankId and accountFingerprint overrides", () => {
    const movements = parseBanreservasEmpresasTransactionRows(banreservasEmpresasTransactions, {
      bankId: "banreservas-custom",
      accountFingerprint: "banreservas-custom-fp",
    });
    expect(movements[0].bankId).toBe("banreservas-custom");
    expect(movements[0].accountFingerprint).toBe("banreservas-custom-fp");
  });

  it("rejects malformed dates in transaction rows", () => {
    expect(() =>
      parseBanreservasEmpresasTransactionRows([{ ...banreservasEmpresasTransactions[0], date: "2026-06-29" }]),
    ).toThrow("Invalid Banreservas Empresas date format");
  });

  it("rejects malformed amounts in transaction rows", () => {
    expect(() =>
      parseBanreservasEmpresasTransactionRows([
        { ...banreservasEmpresasTransactions[0], debit: "abc", credit: "0.00" },
      ]),
    ).toThrow("Invalid Banreservas Empresas amount format");
  });

  it("rejects malformed comma grouping in transaction rows", () => {
    expect(() =>
      parseBanreservasEmpresasTransactionRows([
        { ...banreservasEmpresasTransactions[0], debit: "0.00", credit: "44,00.00" },
      ]),
    ).toThrow("Invalid Banreservas Empresas amount format");
  });

  it("rejects row where both debit and credit are non-zero", () => {
    expect(() =>
      parseBanreservasEmpresasTransactionRows([
        { ...banreservasEmpresasTransactions[0], debit: "193.15", credit: "25,000.00" },
      ]),
    ).toThrow("ambiguous");
  });

  it("rejects row where both debit and credit are zero", () => {
    expect(() =>
      parseBanreservasEmpresasTransactionRows([
        { ...banreservasEmpresasTransactions[0], debit: "0.00", credit: "0.00" },
      ]),
    ).toThrow("missing");
  });

  it.each([
    ["-5,000.00", "0.00", "debit column"],
    ["0.00", "-1,000.00", "credit column"],
  ])("rejects negative amount in %s (%s) — %s sign/column mismatch", (debit, credit) => {
    expect(() =>
      parseBanreservasEmpresasTransactionRows([
        { ...banreservasEmpresasTransactions[0], debit, credit },
      ]),
    ).toThrow("sign/column mismatch");
  });

  it("rejects malformed zero in inactive debit column", () => {
    expect(() =>
      parseBanreservasEmpresasTransactionRows([
        { ...banreservasEmpresasTransactions[0], debit: "0,00.00", credit: "25,000.00" },
      ]),
    ).toThrow("Invalid Banreservas Empresas amount format");
  });

  it("rejects malformed zero in inactive credit column", () => {
    expect(() =>
      parseBanreservasEmpresasTransactionRows([
        { ...banreservasEmpresasTransactions[0], debit: "193.15", credit: "0,00.00" },
      ]),
    ).toThrow("Invalid Banreservas Empresas amount format");
  });

  it("normalizes whitespace-only transactionNumber to null and trims valid reference", () => {
    const nullRef = parseBanreservasEmpresasTransactionRows([
      { ...banreservasEmpresasTransactions[0], transactionNumber: "   " },
    ]);
    expect(nullRef[0].reference).toBeNull();
    const validRef = parseBanreservasEmpresasTransactionRows([
      { ...banreservasEmpresasTransactions[0], transactionNumber: "942632990001" },
    ]);
    expect(validRef[0].reference).toBe("942632990001");
  });

  it("balance is NOT leaked into metadata or any output field", () => {
    const movements = parseBanreservasEmpresasTransactionRows(banreservasEmpresasTransactions);
    for (const m of movements) {
      expect(m.metadata).toBeNull();
      expect(m.concept).not.toContain("DOP");
      expect(m.concept).not.toContain("29,472.55");
      expect(m.concept).not.toContain("4,472.55");
    }
  });

  it("normalizes description whitespace", () => {
    const movements = parseBanreservasEmpresasTransactionRows([
      { ...banreservasEmpresasTransactions[0], description: "  DEPOSITO  EN   EFECTIVO  " },
    ]);
    expect(movements[0].concept).toBe("DEPOSITO EN EFECTIVO");
  });
});
