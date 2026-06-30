/** Banreservas Personas + Empresas — read-only adapter skeletons (PR5B2/PR5B3)
 *  + Personas DOM extraction parser (PR5D/PR5F). */

import type { BankMovement, TransactionDirection } from "../../modules/transactions";
import type { IngestionScraper } from "../../worker/queues";
import type { CdpSessionChecker } from "../../modules/bank-sessions";
import type { BankAdapter, BankAutoLoginStrategy } from "./registry";
import type { BanreservasPersonasTransaction } from "./fixtures/types";

/**
 * Portal-specific bank codes for Banreservas Personas and Empresas.
 *
 * Both variants share the same brand but are completely different tech stacks
 * (Angular SPA vs ASP.NET WebForms frameset). The codebase keys adapters,
 * credentials, and scrape-run routing by `bankCode`, so each portal MUST have
 * a unique bankCode to avoid `Map.set` collisions in `BankAdapterRegistry` and
 * unique-constraint violations in `BankCredentialRepository`.
 *
 * `banreservasBankGroupCode` is a display/metadata grouping concept only — it
 * is NOT used for registry routing or credential storage.
 */
export const banreservasBankGroupCode = "banreservas" as const;
export const banreservasPersonasBankCode = "banreservas_personas" as const;
export const banreservasEmpresasBankCode = "banreservas_empresas" as const;
export const banreservasPersonasPortalVariant = "personas" as const;
export const banreservasEmpresasPortalVariant = "empresas" as const;

// ── Personas (Angular SPA — tubanco.banreservas.com) ─────────────────────

export const banreservasPersonasScraperProfile = {
  bankId: banreservasPersonasBankCode,
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
  bankCode: banreservasPersonasBankCode,
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
  bankId: banreservasEmpresasBankCode,
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
  bankCode: banreservasEmpresasBankCode,
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

// ---------------------------------------------------------------------------
// Transaction parser — Banreservas Personas DD/MM/YYYY + comma amounts → BankMovement
// ---------------------------------------------------------------------------

const SANTO_DOMINGO_OFFSET = "-04:00";

export interface BanreservasPersonasParseOptions {
  accountFingerprint?: string;
  bankId?: string;
  currency?: string;
}

export function parseBanreservasPersonasDate(value: string): string {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value.trim());
  if (!match) throw new Error("Invalid Banreservas Personas date format");

  const [, dayStr, monthStr, yearStr] = match;
  const day = Number(dayStr);
  const month = Number(monthStr);
  const year = Number(yearStr);

  // Validate month range.
  if (month < 1 || month > 12) throw new Error("Invalid Banreservas Personas date format");

  // Validate day range for the given month (including leap-year check for Feb).
  const daysInMonth = new Date(year, month, 0).getDate();
  if (day < 1 || day > daysInMonth) throw new Error("Invalid Banreservas Personas date format");

  return `${yearStr}-${monthStr}-${dayStr}T00:00:00${SANTO_DOMINGO_OFFSET}`;
}

export function parseBanreservasPersonasAmount(value: string): { value: number; direction: TransactionDirection } {
  const trimmed = value.trim();
  if (trimmed === "") throw new Error("Invalid Banreservas Personas amount format");

  // Validate comma grouping BEFORE stripping: commas must follow standard
  // thousands grouping (exactly 3 digits after each comma).  This rejects
  // malformed inputs like "44,00.00" or "4,4,000.00" that a blind strip-all-commas
  // approach would silently accept.
  const hasCommas = trimmed.includes(",");
  if (hasCommas && !/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(trimmed)) {
    throw new Error("Invalid Banreservas Personas amount format");
  }

  const normalized = trimmed.replace(/,/g, "");
  // Reject malformed patterns: leading/trailing dots, double negatives, etc.
  if (!/^-?\d+(\.\d+)?$/.test(normalized)) {
    throw new Error("Invalid Banreservas Personas amount format");
  }

  const amount = Number(normalized);
  if (!Number.isFinite(amount)) throw new Error("Invalid Banreservas Personas amount format");

  return {
    value: amount,
    direction: amount < 0 ? "debit" : "credit",
  };
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

/**
 * Parse the Banreservas Personas pipe-separated reference field into a
 * human-readable string. The raw reference is in the form:
 *   `# Nro. transacción : 408900123456 | Número de referencia : 408900123`
 * We normalize to: `Nro. transacción: 408900123456 | Número de referencia: 408900123`
 */
function parseBanreservasPersonasReference(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  // Split on pipe and normalize each part: strip leading `# ` and trim whitespace.
  const parts = trimmed.split("|").map((part) => {
    const cleaned = part.trim().replace(/^#\s*/, "");
    // Collapse whitespace around colon: `Nro. transacción :` → `Nro. transacción:`
    return cleaned.replace(/\s*:\s*/, ": ");
  });

  return parts.join(" | ");
}

export function parseBanreservasPersonasTransactionRows(
  rows: readonly BanreservasPersonasTransaction[],
  options: BanreservasPersonasParseOptions = {},
): BankMovement[] {
  return rows.map((row) => {
    const postedAt = parseBanreservasPersonasDate(row.date);

    // Debit and credit are separate columns — exactly one must be populated.
    const debitText = row.debit.trim();
    const creditText = row.credit.trim();

    let amount: number;
    let direction: TransactionDirection;

    if (debitText && creditText) {
      throw new Error(
        `Banreservas Personas parser: ambiguous amount — both debit ("${debitText}") and credit ("${creditText}") are populated`,
      );
    }

    if (!debitText && !creditText) {
      throw new Error(
        "Banreservas Personas parser: missing amount — both debit and credit columns are empty",
      );
    }

    if (debitText) {
      const parsed = parseBanreservasPersonasAmount(debitText);
      // Sign/column mismatch: positive amount in debit column is invalid.
      if (parsed.direction !== "debit") {
        throw new Error(
          `Banreservas Personas parser: sign/column mismatch — debit column contains positive amount "${debitText}"`,
        );
      }
      amount = parsed.value;
      direction = parsed.direction;
    } else {
      const parsed = parseBanreservasPersonasAmount(creditText);
      // Sign/column mismatch: negative amount in credit column is invalid.
      if (parsed.direction !== "credit") {
        throw new Error(
          `Banreservas Personas parser: sign/column mismatch — credit column contains negative amount "${creditText}"`,
        );
      }
      amount = parsed.value;
      direction = parsed.direction;
    }

    return {
      bankId: options.bankId ?? banreservasPersonasBankCode,
      accountFingerprint: options.accountFingerprint ?? banreservasPersonasScraperProfile.accountFingerprint,
      postedAt,
      amount: Math.abs(amount).toFixed(2),
      currency: options.currency ?? "DOP",
      direction,
      reference: parseBanreservasPersonasReference(row.reference),
      concept: normalizeText(row.description),
      originator: null,
      metadata: null,
    };
  });
}

// ── Adapter factories + stubs ────────────────────────────────────────────

function createPersonasAdapter(opts: { createScraper: () => IngestionScraper; createSessionChecker: () => CdpSessionChecker }): BankAdapter & { readonly portalVariant: string; createSessionChecker(): CdpSessionChecker } {
  return { bankCode: banreservasPersonasBankCode, portalVariant: banreservasPersonasPortalVariant, createScraper: opts.createScraper, createSessionChecker: opts.createSessionChecker, createAutoLoginStrategy: createBanreservasAutoLoginStrategy };
}

function createEmpresasAdapter(opts: { createScraper: () => IngestionScraper; createSessionChecker: () => CdpSessionChecker }): BankAdapter & { readonly portalVariant: string; createSessionChecker(): CdpSessionChecker } {
  return { bankCode: banreservasEmpresasBankCode, portalVariant: banreservasEmpresasPortalVariant, createScraper: opts.createScraper, createSessionChecker: opts.createSessionChecker, createAutoLoginStrategy: createBanreservasAutoLoginStrategy };
}

const personasStubScraper: IngestionScraper = { collect: async () => ({ status: "needs_admin_action" as const, movements: [], safeErrorSummary: "Banreservas Personas adapter is a skeleton" }) };
const empresasStubScraper: IngestionScraper = { collect: async () => ({ status: "needs_admin_action" as const, movements: [], safeErrorSummary: "Banreservas Empresas adapter is a skeleton" }) };
/** Fail-safe: returns expired until real CDP session checker exists (PR5C/D/E). */
const stubSessionChecker: CdpSessionChecker = { check: async () => ({ status: "expired", checkedAt: new Date().toISOString(), safeSummary: "Bank session expired or requires verification" }) };

export const banreservasPersonasAdapter = createPersonasAdapter({ createScraper: () => personasStubScraper, createSessionChecker: () => stubSessionChecker });
export const banreservasEmpresasAdapter = createEmpresasAdapter({ createScraper: () => empresasStubScraper, createSessionChecker: () => stubSessionChecker });
