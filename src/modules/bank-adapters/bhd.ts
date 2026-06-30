/** BHD Personal — read-only adapter skeleton (PR5B). Angular/PrimeNG SPA, scroll-stabilize. */
/* PR5B NOTE: BHD is NOT registered in the bankCode-keyed registry yet. Registration
   lands in PR5.2 or later; this file exports the skeleton for testing only. */

import type { BankMovement, TransactionDirection } from "../../modules/transactions";
import type { IngestionScraper } from "../../worker/queues";
import type { CdpSessionChecker } from "../../modules/bank-sessions";
import type { BankAdapter, BankAutoLoginStrategy } from "./registry";
import type { BhdPersonalTransaction } from "./fixtures/types";

export const bhdBankCode = "bhd" as const;
export const bhdPersonalPortalVariant = "personal" as const;

export const bhdPersonalScraperProfile = {
  bankId: bhdBankCode,
  portalVariant: bhdPersonalPortalVariant,
  loginUrl: "https://ibp.bhd.com.do/#/login",
  accountFingerprint: "bhd-XXXXXXXXXX",
  loginStrategy: "admin-assisted-first-login+remember-browser+cdp-attach",
  routes: { dashboard: "#/bhd/dashboard", productDetail: "#/bhd/product-detail" },
  selectors: {
    usernameInput: "input#userName",
    passwordInput: "input#password",
    captchaArea: "div.field.col-10.mb-2",
    submitButton: "button[type='submit'].bhd-btn-primary",
    accountCard: "app-account-card",
    viewMovementsButton: "button.bhd-btn-primary",
    periodDropdown: "div.p-select-dropdown",
    fromDateInput: "input.p-datepicker-input[placeholder='Fecha inicio']",
    toDateInput: "input.p-datepicker-input[placeholder='Fecha final']",
    searchInput: "input[placeholder='Buscar']",
    transactionTable: "table.p-datatable-table",
    transactionRow: "tr.body-responsive",
  },
  columnMapping: { date: 0, confirmation: 1, description: 2, receipt: 3, debit: 4, credit: 5, balance: 6 },
  formats: { date: "DD/MM/YYYY", amount: "RD$ 1,234.56" },
  paginationStrategy: "scroll-stabilize" as const,
} as const;

export const bhdPersonalPortalConfig = {
  bankCode: bhdBankCode,
  baseUrl: "https://ibp.bhd.com.do",
  loginPathAllowlist: ["/#/login"] as readonly string[],
  cdpUrlEnv: "RD_SYNC_BANK_BHD_CDP_URL",
  profileDirEnv: "RD_SYNC_BANK_BHD_PROFILE_DIR",
  startUrlEnv: "RD_SYNC_BANK_BHD_START_URL",
  usernameSelector: bhdPersonalScraperProfile.selectors.usernameInput,
  passwordSelector: bhdPersonalScraperProfile.selectors.passwordInput,
  submitSelector: bhdPersonalScraperProfile.selectors.submitButton,
  incompatibleFlowSelector: undefined,
} as const;

// ---------------------------------------------------------------------------
// Transaction parser — BHD Personal DD/MM/YYYY + RD$ amounts → BankMovement
// ---------------------------------------------------------------------------

const SANTO_DOMINGO_OFFSET = "-04:00";

export interface BhdPersonalParseOptions {
  accountFingerprint?: string;
  bankId?: string;
  currency?: string;
}

export function parseBhdDate(value: string): string {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value.trim());
  if (!match) throw new Error("Invalid BHD date format");

  const [, dayStr, monthStr, yearStr] = match;
  const day = Number(dayStr);
  const month = Number(monthStr);
  const year = Number(yearStr);

  // Validate month range.
  if (month < 1 || month > 12) throw new Error("Invalid BHD date format");

  // Validate day range for the given month (including leap-year check for Feb).
  const daysInMonth = new Date(year, month, 0).getDate();
  if (day < 1 || day > daysInMonth) throw new Error("Invalid BHD date format");

  return `${yearStr}-${monthStr}-${dayStr}T00:00:00${SANTO_DOMINGO_OFFSET}`;
}

export function parseBhdAmount(value: string): { value: number; direction: TransactionDirection } {
  const normalized = value
    .replace(/RD\$/gi, "")
    .replace(/,/g, "")
    .trim();
  if (normalized === "") throw new Error("Invalid BHD amount format");
  const amount = Number(normalized);
  if (!Number.isFinite(amount)) throw new Error("Invalid BHD amount format");

  return {
    value: amount,
    direction: amount < 0 ? "debit" : "credit",
  };
}

function normalizeOptionalField(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function parseBhdTransactionRows(
  rows: readonly BhdPersonalTransaction[],
  options: BhdPersonalParseOptions = {},
): BankMovement[] {
  return rows.map((row) => {
    const postedAt = parseBhdDate(row.date);

    // Debit and credit are separate columns — exactly one must be populated.
    const debitText = row.debit.trim();
    const creditText = row.credit.trim();

    let amount: number;
    let direction: TransactionDirection;

    if (debitText && creditText) {
      throw new Error(
        `BHD parser: ambiguous amount — both debit ("${debitText}") and credit ("${creditText}") are populated`,
      );
    }

    if (!debitText && !creditText) {
      throw new Error(
        "BHD parser: missing amount — both debit and credit columns are empty",
      );
    }

    if (debitText) {
      const parsed = parseBhdAmount(debitText);
      amount = parsed.value;
      direction = "debit";
    } else {
      const parsed = parseBhdAmount(creditText);
      amount = parsed.value;
      direction = "credit";
    }

    return {
      bankId: options.bankId ?? bhdBankCode,
      accountFingerprint: options.accountFingerprint ?? bhdPersonalScraperProfile.accountFingerprint,
      postedAt,
      amount: Math.abs(amount).toFixed(2),
      currency: options.currency ?? "DOP",
      direction,
      reference: normalizeOptionalField(row.confirmationNumber),
      concept: normalizeText(row.description),
      originator: null,
      metadata: {
        receipt: normalizeOptionalField(row.receipt),
      },
    };
  });
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function createBhdAutoLoginStrategy(): BankAutoLoginStrategy {
  throw new Error("BHD auto-login strategy is not implemented yet (PR6)");
}

export function createBhdPersonalAdapter(options: {
  createScraper: () => IngestionScraper;
  createSessionChecker: () => CdpSessionChecker;
}): BankAdapter & {
  readonly portalVariant: string;
  createSessionChecker(): CdpSessionChecker;
} {
  return {
    bankCode: bhdBankCode,
    portalVariant: bhdPersonalPortalVariant,
    createScraper: options.createScraper,
    createSessionChecker: options.createSessionChecker,
    createAutoLoginStrategy: createBhdAutoLoginStrategy,
  };
}

const bhdStubScraper: IngestionScraper = {
  collect: async () => ({
    status: "needs_admin_action" as const,
    movements: [],
    safeErrorSummary: "BHD Personal adapter is a skeleton",
  }),
};

/** Fail-safe stub: returns expired until real CDP session checker exists in PR5C/D/E. */
const bhdStubSessionChecker: CdpSessionChecker = {
  check: async () => ({
    status: "expired",
    checkedAt: new Date().toISOString(),
    safeSummary: "Bank session expired or requires verification",
  }),
};

export const bhdPersonalAdapter = createBhdPersonalAdapter({
  createScraper: () => bhdStubScraper,
  createSessionChecker: () => bhdStubSessionChecker,
});
