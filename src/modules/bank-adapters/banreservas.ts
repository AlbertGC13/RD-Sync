/** Banreservas Personas + Empresas — read-only adapter skeletons (PR5B2). */
/* PR5B2 NOTE: Both variants share `bankCode: "banreservas"` but are TWO
   completely different tech stacks (Angular SPA vs ASP.NET WebForms frameset).
   Registration/routing is deferred to PR5.2+ when a routing strategy exists. */

import type { IngestionScraper } from "../../worker/queues";
import type { CdpSessionChecker } from "../../modules/bank-sessions";
import type { BankAdapter, BankAutoLoginStrategy } from "./registry";

export const banreservasBankCode = "banreservas" as const;
export const banreservasPersonasPortalVariant = "personas" as const;
export const banreservasEmpresasPortalVariant = "empresas" as const;

// ── Personas (Angular SPA — tubanco.banreservas.com) ─────────────────────

export const banreservasPersonasScraperProfile = {
  bankId: banreservasBankCode,
  portalVariant: banreservasPersonasPortalVariant,
  loginUrl: "https://tubanco.banreservas.com/TuBancoBanreservas/#/administrationGeneral/login",
  rootElement: "icb-app",
  accountFingerprint: "banreservas-XXXXXXXXXX",
  defaultSearchMode: "current-month",
  inputStrategy: "trusted-click+angular-events" as const,
  selectors: {
    usernameInput: "input[formControlName='username']#step01",
    passwordInput: "input[formControlName='password']#step02",
    submitLink: "a.ipswich-main-buttons-link.default.big",
    submitInactiveClass: "inactive",
    periodChipLabel: "span.oldham-panel-title-text",
    periodOption: "a.oldham-panel-link",
    calendar: {
      root: "div.memphis-main-block.memphis-main-dayView",
      prevMonth: "a.leftArrow",
      nextMonth: "a.rightArrow",
      dayCell: "a.memphis-day-value",
      todayReset: "a.memphis-day-button-reset",
    },
    transactionRow: "div.rivera_row",
    rowDate: "div.rivera_row_info_legend span.marmaris[data-type='date']",
    rowDescription: "div.rivera_row_info_title span.marmaris[data-type='string']",
    rowReference: "div.rivera_row_info_subtitle span.marmaris[data-type='textResourceKey']",
    rowDebit: "div.rivera_row_simple",
    rowBalance: "div.rivera_row_simple.highlighted",
    loadMore: "div.florida_wrapper_loader_default",
    searchInput: "input.estambul_input",
  },
  formats: { date: "DD/MM/YYYY", amount: "-1,234.56", currencyPrefix: "DOP" },
} as const;

export const banreservasPersonasPortalConfig = {
  bankCode: banreservasBankCode,
  baseUrl: "https://tubanco.banreservas.com",
  loginPathAllowlist: ["/#/administrationGeneral/login"] as readonly string[],
  cdpUrlEnv: "RD_SYNC_BANK_BANRESERVAS_PERSONAS_CDP_URL",
  profileDirEnv: "RD_SYNC_BANK_BANRESERVAS_PERSONAS_PROFILE_DIR",
  startUrlEnv: "RD_SYNC_BANK_BANRESERVAS_PERSONAS_START_URL",
  usernameSelector: banreservasPersonasScraperProfile.selectors.usernameInput,
  passwordSelector: banreservasPersonasScraperProfile.selectors.passwordInput,
  submitSelector: banreservasPersonasScraperProfile.selectors.submitLink,
  incompatibleFlowSelector: undefined,
} as const;

// ── Empresas (ASP.NET WebForms frameset — www.banreservas.com.do) ────────

export const banreservasEmpresasScraperProfile = {
  bankId: banreservasBankCode,
  portalVariant: banreservasEmpresasPortalVariant,
  loginUrl: "https://www.banreservas.com.do/TuBancoEmpresas/Login.aspx",
  landingUrl: "https://www.banreservas.com.do/TuBancoEmpresas/Default.aspx",
  framework: "aspnet-webforms+devexpress" as const,
  frames: { top: "topFrame", left: "leftFrame", main: "mainFrame" },
  routes: {
    accounts: "/TuBancoEmpresas/Pages/Accounts/Accounts.aspx",
    statementPdf: "/TuBancoEmpresas/Pages/Accounts/AccountStatusPDF.aspx",
  },
  inputStrategy: "type+postback" as const,
  selectors: {
    usernameInput: "input#ctl00_MainHolder_LoginView_UserName",
    passwordInput: "input#ctl00_MainHolder_LoginView_Password",
    captchaInput: "input#ctl00_MainHolder_LoginView_tbCaptcha",
    submitButton: "input#ctl00_MainHolder_LoginView_btnLogin",
    accountsGrid: "table#ctl00_MainHolder_AccountGrid_AccountASPxGridView_DXMainTable",
    dateFrom: "input#ctl00_MainHolder_period_dateTextBoxDateFrom",
    dateTo: "input#ctl00_MainHolder_period_dateTextBoxDateTo",
    consultarButton: "a#ctl00_MainHolder_period_linkButtonConsultar",
    transactionGrid: "table#ctl00_MainHolder_AccountTransactionGrid_ASPxGridViewTransactions",
    transactionRow: "tr[id*='_DXDataRow'].dxgvDataRow",
    exportPdf: "a#ctl00_MainHolder_AccountTransactionGrid_linkButtonGeneratePDF",
    exportCsv: "a#ctl00_MainHolder_AccountTransactionGrid_linkButtonCSV",
    exportExcel: "a#ctl00_MainHolder_AccountTransactionGrid_linkButton2",
  },
  formats: { date: "DD/MM/YY", amount: "1,234.56", balancePrefix: "DOP" },
} as const;

export const banreservasEmpresasPortalConfig = {
  bankCode: banreservasBankCode,
  baseUrl: "https://www.banreservas.com.do",
  loginPathAllowlist: ["/TuBancoEmpresas/Login.aspx"] as readonly string[],
  cdpUrlEnv: "RD_SYNC_BANK_BANRESERVAS_EMPRESAS_CDP_URL",
  profileDirEnv: "RD_SYNC_BANK_BANRESERVAS_EMPRESAS_PROFILE_DIR",
  startUrlEnv: "RD_SYNC_BANK_BANRESERVAS_EMPRESAS_START_URL",
  usernameSelector: banreservasEmpresasScraperProfile.selectors.usernameInput,
  passwordSelector: banreservasEmpresasScraperProfile.selectors.passwordInput,
  submitSelector: banreservasEmpresasScraperProfile.selectors.submitButton,
  incompatibleFlowSelector: undefined,
} as const;

// ── Auto-login stub ──────────────────────────────────────────────────────

export function createBanreservasAutoLoginStrategy(): BankAutoLoginStrategy {
  throw new Error("Banreservas auto-login strategy is not implemented yet (PR6)");
}

// ── Adapter factories + stubs ────────────────────────────────────────────

function createPersonasAdapter(opts: { createScraper: () => IngestionScraper; createSessionChecker: () => CdpSessionChecker }): BankAdapter & { readonly portalVariant: string; createSessionChecker(): CdpSessionChecker } {
  return { bankCode: banreservasBankCode, portalVariant: banreservasPersonasPortalVariant, createScraper: opts.createScraper, createSessionChecker: opts.createSessionChecker, createAutoLoginStrategy: createBanreservasAutoLoginStrategy };
}

function createEmpresasAdapter(opts: { createScraper: () => IngestionScraper; createSessionChecker: () => CdpSessionChecker }): BankAdapter & { readonly portalVariant: string; createSessionChecker(): CdpSessionChecker } {
  return { bankCode: banreservasBankCode, portalVariant: banreservasEmpresasPortalVariant, createScraper: opts.createScraper, createSessionChecker: opts.createSessionChecker, createAutoLoginStrategy: createBanreservasAutoLoginStrategy };
}

const personasStubScraper: IngestionScraper = { collect: async () => ({ status: "needs_admin_action" as const, movements: [], safeErrorSummary: "Banreservas Personas adapter is a skeleton" }) };
const empresasStubScraper: IngestionScraper = { collect: async () => ({ status: "needs_admin_action" as const, movements: [], safeErrorSummary: "Banreservas Empresas adapter is a skeleton" }) };
/** Fail-safe: returns expired until real CDP session checker exists (PR5C/D/E). */
const stubSessionChecker: CdpSessionChecker = { check: async () => ({ status: "expired", checkedAt: new Date().toISOString(), safeSummary: "Bank session expired or requires verification" }) };

export const banreservasPersonasAdapter = createPersonasAdapter({ createScraper: () => personasStubScraper, createSessionChecker: () => stubSessionChecker });
export const banreservasEmpresasAdapter = createEmpresasAdapter({ createScraper: () => empresasStubScraper, createSessionChecker: () => stubSessionChecker });
