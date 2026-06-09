import type { BankMovement, TransactionDirection } from "../transactions";

const POPULAR_BANK_ID = "popular";
const POPULAR_ACCOUNT_NUMBER = "817985690";
const POPULAR_ACCOUNT_FINGERPRINT = "popular-817985690";
const POPULAR_CURRENCY = "DOP";
const SANTO_DOMINGO_OFFSET = "-04:00";

export interface PopularTransactionRow {
  postedDate: string;
  effectiveDate: string;
  checkNumber?: string | null;
  referenceNumber?: string | null;
  description: string;
  amount: string;
  balance?: string | null;
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
  defaultSearchMode: "current-day",
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
    defaultSearchMode: "current-day",
    fromDate: "09/mayo/2026",
    toDate: "08/junio/2026",
  },
  transactions: [
    {
      postedDate: "11/05/2026",
      effectiveDate: "09/05/2026",
      description: "Devolucion Jueves TOKE RD$ .00",
      amount: "$100.00",
      balance: "$2,031.49",
      detailAvailable: true,
    },
    {
      postedDate: "11/05/2026",
      effectiveDate: "09/05/2026",
      checkNumber: "0612915426447",
      description: "BANCO POPULAR OFICINA EL SANTIAGO 612915426447 090526 DEP C TACTE BPD0344",
      amount: "$97,000.00",
      balance: "$99,031.49",
      detailAvailable: true,
    },
    {
      postedDate: "11/05/2026",
      effectiveDate: "09/05/2026",
      checkNumber: "0612915426452",
      description: "BANCO POPULAR OFICINA EL SANTIAGO 612915426452 090526 DEP C TACTE BPD0344",
      amount: "$17,000.00",
      balance: "$116,031.49",
      detailAvailable: true,
    },
    {
      postedDate: "11/05/2026",
      effectiveDate: "09/05/2026",
      checkNumber: "0000816840623",
      description: "MB a 0816840623 lovely",
      amount: "$-115,500.00",
      balance: "$531.49",
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
  if (!match) throw new Error(`Invalid Popular date: ${value}`);

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
  if (!Number.isFinite(amount)) throw new Error(`Invalid Popular amount: ${value}`);

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
