/** BHD Personal — read-only adapter skeleton (PR5B). Angular/PrimeNG SPA, scroll-stabilize. */
/* PR5B NOTE: BHD is NOT registered in the bankCode-keyed registry yet. Registration
   lands in PR5.2 or later; this file exports the skeleton for testing only. */

import type { IngestionScraper } from "../../worker/queues";
import type { CdpSessionChecker } from "../../modules/bank-sessions";
import type { BankAdapter, BankAutoLoginStrategy } from "./registry";

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
