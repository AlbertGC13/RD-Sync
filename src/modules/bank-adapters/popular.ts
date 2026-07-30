import type { BankMovement, TransactionDirection } from "../transactions";
import type { BankAdapter } from "./registry";

const POPULAR_BANK_ID = "popular";

/**
 * Canonical immutable domain code for Popular (`Bank.code`). This is the
 * adapter/job/API/credential identity — NOT the cuid `Bank.id` DB primary key.
 * Exported so the registry and routing layer share one constant.
 */
export const popularBankCode = "popular" as const;
const POPULAR_ACCOUNT_NUMBER = "0000000000";
const POPULAR_ACCOUNT_FINGERPRINT = "popular-0000000000";
const POPULAR_CURRENCY = "DOP";
const SANTO_DOMINGO_OFFSET = "-04:00";

export interface PopularTransactionRow {
  postedDate: string;
  effectiveDate: string;
  checkNumber?: string | null;
  referenceNumber?: string | null;
  description: string;
  amount: string;
  imageAvailable?: boolean;
  detailAvailable?: boolean;
}

export interface PopularParseOptions {
  accountFingerprint?: string;
  bankId?: string;
  currency?: string;
}

export const popularScraperProfile = {
  bankId: POPULAR_BANK_ID,
  accountFingerprint: POPULAR_ACCOUNT_FINGERPRINT,
  defaultSearchMode: "recent-lookback-window",
  selectors: {
    accountNumberText: POPULAR_ACCOUNT_NUMBER,
    accountTypeText: "Corriente",
    fromDateInput: "input[name='sDate']",
    toDateInput: "input[name='eDate']",
    transactionTypeSelect: "select[name='transit']",
    searchButtonText: "Buscar",
    resultsTable: "table:has-text('Fecha posteo')",
  },
} as const;

export const popularPortalFixture = {
  dashboard: {
    accounts: [
      {
        accountNumber: POPULAR_ACCOUNT_NUMBER,
        accountType: "Corriente",
        currency: POPULAR_CURRENCY,
      },
    ],
  },
  accountDetail: {
    accountNumber: POPULAR_ACCOUNT_NUMBER,
    accountType: "Corriente",
    currency: POPULAR_CURRENCY,
  },
  search: {
    defaultSearchMode: "recent-lookback-window",
    fromDate: "01/enero/2025",
    toDate: "01/enero/2025",
  },
  transactions: [
    {
      postedDate: "01/01/2025",
      effectiveDate: "01/01/2025",
      description: "PAGO FICTICIO 001",
      amount: "$100.00",
      detailAvailable: true,
    },
    {
      postedDate: "01/01/2025",
      effectiveDate: "01/01/2025",
      checkNumber: "0001000000001",
      description: "DEPOSITO FICTICIO 002",
      amount: "$97,000.00",
      detailAvailable: true,
    },
    {
      postedDate: "01/01/2025",
      effectiveDate: "01/01/2025",
      checkNumber: "0002000000002",
      description: "DEPOSITO FICTICIO 003",
      amount: "$17,000.00",
      detailAvailable: true,
    },
    {
      postedDate: "01/01/2025",
      effectiveDate: "01/01/2025",
      checkNumber: "0003000000003",
      description: "PAGO FICTICIO 004",
      amount: "$-115,500.00",
      detailAvailable: true,
    },
  ] satisfies PopularTransactionRow[],
} as const;

export function parsePopularTransactionRows(
  rows: readonly PopularTransactionRow[],
  options: PopularParseOptions = {},
): BankMovement[] {
  return rows.map((row) => {
    const amount = parsePopularAmount(row.amount);
    const postedAt = parsePopularDate(row.postedDate);
    const effectiveAt = parsePopularDate(row.effectiveDate);
    const checkNumber = normalizeOptionalText(row.checkNumber);
    const referenceNumber = normalizeOptionalText(row.referenceNumber);

    return {
      bankId: options.bankId ?? POPULAR_BANK_ID,
      accountFingerprint: options.accountFingerprint ?? POPULAR_ACCOUNT_FINGERPRINT,
      postedAt,
      amount: Math.abs(amount.value).toFixed(2),
      currency: options.currency ?? POPULAR_CURRENCY,
      direction: amount.direction,
      reference: referenceNumber ?? checkNumber,
      concept: normalizeText(row.description),
      originator: null,
      metadata: {
        effectiveAt,
        checkNumber,
        referenceNumber,
        imageAvailable: row.imageAvailable ?? false,
        detailAvailable: row.detailAvailable ?? false,
      },
    };
  });
}

function parsePopularDate(value: string): string {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value.trim());
  if (!match) throw new Error("Invalid Popular date format");

  const [, day, month, year] = match;
  return `${year}-${month}-${day}T00:00:00${SANTO_DOMINGO_OFFSET}`;
}

function parsePopularAmount(value: string): { value: number; direction: TransactionDirection } {
  const normalized = value
    .replace(/RD\$/gi, "")
    .replace(/\$/g, "")
    .replace(/,/g, "")
    .trim();
  const amount = Number(normalized);
  if (!Number.isFinite(amount)) throw new Error("Invalid Popular amount format");

  return {
    value: amount,
    direction: amount < 0 ? "debit" : "credit",
  };
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

// ---------------------------------------------------------------------------
// Bank adapter — exposes Popular as a `BankAdapter` keyed by `bankCode`.
//
// The domain module stays free of worker/runtime coupling. Both factories are
// injected by the server wiring layer, which owns CDP and login state machines.
// ---------------------------------------------------------------------------

/**
 * Builds the Popular `BankAdapter` from server-owned factories. This module
 * deliberately imports no worker module, avoiding a domain-to-worker cycle.
 */
export function createPopularBankAdapter(options: {
  createScraper: BankAdapter["createScraper"];
  createAutoLoginStrategy: BankAdapter["createAutoLoginStrategy"];
}): BankAdapter {
  return {
    bankCode: popularBankCode,
    createScraper: options.createScraper,
    createAutoLoginStrategy: options.createAutoLoginStrategy,
  };
}
