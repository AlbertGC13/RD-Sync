import type { BankMovement } from "../transactions";

const SANTO_DOMINGO_OFFSET = "-04:00";
const DEFAULT_ACCOUNT_FINGERPRINT = "bhd-XXXXXXXXXX";

/** Canonical immutable domain code for BHD. This slice is not runtime-registered. */
export const bhdBankCode = "bhd" as const;
export const bhdPersonalPortalVariant = "personal" as const;

export interface BhdPersonalTransaction {
  date: string;
  confirmationNumber: string;
  description: string;
  receipt: string;
  debit: string;
  credit: string;
  balance: string;
}

export interface BhdPersonalParseOptions {
  accountFingerprint?: string;
  bankId?: string;
  currency?: string;
}

/** Declarative portal evidence only; connection and login behavior remain out of this slice. */
export const bhdPersonalPortalProfile = {
  bankCode: bhdBankCode,
  portalVariant: bhdPersonalPortalVariant,
  sessionAccess: "admin-assisted-cdp-attach",
  selectors: {
    transactionTable: "table.p-datatable-table",
    transactionRow: "tr.body-responsive",
    fromDateInput: "input[placeholder='Fecha inicio']",
    toDateInput: "input[placeholder='Fecha final']",
  },
  columnMapping: { date: 0, confirmation: 1, description: 2, receipt: 3, debit: 4, credit: 5, balance: 6 },
  formats: { date: "DD/MM/YYYY", amount: "RD$ 1,234.56" },
} as const;

export function parseBhdDate(value: string): string {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value.trim());
  if (!match) throw new Error("Invalid BHD date format");

  const [, dayText, monthText, yearText] = match;
  const day = Number(dayText);
  const month = Number(monthText);
  const year = Number(yearText);
  if (month < 1 || month > 12 || day < 1 || day > new Date(year, month, 0).getDate()) {
    throw new Error("Invalid BHD date format");
  }

  return `${yearText}-${monthText}-${dayText}T00:00:00${SANTO_DOMINGO_OFFSET}`;
}

export function parseBhdAmount(value: string): number {
  const normalized = value.replace(/RD\$/gi, "").replace(/,/g, "").trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(normalized)) throw new Error("Invalid BHD amount format");

  const amount = Number(normalized);
  if (!Number.isFinite(amount)) throw new Error("Invalid BHD amount format");
  return amount;
}

export function parseBhdTransactionRows(
  rows: readonly BhdPersonalTransaction[],
  options: BhdPersonalParseOptions = {},
): BankMovement[] {
  return rows.map((row) => {
    const debit = row.debit.trim();
    const credit = row.credit.trim();
    if (Boolean(debit) === Boolean(credit)) {
      throw new Error("BHD parser requires exactly one populated debit or credit column");
    }

    return {
      bankId: options.bankId ?? bhdBankCode,
      accountFingerprint: options.accountFingerprint ?? DEFAULT_ACCOUNT_FINGERPRINT,
      postedAt: parseBhdDate(row.date),
      amount: Math.abs(parseBhdAmount(debit || credit)).toFixed(2),
      currency: options.currency ?? "DOP",
      direction: debit ? "debit" : "credit",
      reference: normalizeOptionalText(row.confirmationNumber),
      concept: normalizeText(row.description),
      originator: null,
      metadata: { receipt: normalizeOptionalText(row.receipt) },
    };
  });
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function normalizeOptionalText(value: string): string | null {
  return value.trim() || null;
}
