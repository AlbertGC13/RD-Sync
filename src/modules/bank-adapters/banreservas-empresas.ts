import type { BankMovement } from "../transactions";
import { banreservasEmpresasBankCode } from "./bank-identities";

const SANTO_DOMINGO_OFFSET = "-04:00";
const DEFAULT_ACCOUNT_FINGERPRINT = "banreservas_empresas-XXXXXXXXXX";

export { banreservasEmpresasBankCode } from "./bank-identities";
export const banreservasEmpresasPortalVariant = "empresas" as const;

export interface BanreservasEmpresasTransaction {
  date: string;
  transactionNumber: string;
  concept: string;
  debit: string;
  credit: string;
  balance: string;
}

export interface BanreservasEmpresasParseOptions {
  accountFingerprint?: string;
  currency?: string;
}

/** Declarative, inert evidence for the Empresas WebForms/DevExpress portal. */
export const banreservasEmpresasPortalProfile = {
  bankCode: banreservasEmpresasBankCode,
  portalVariant: banreservasEmpresasPortalVariant,
  loginUrl: "https://www.banreservas.com.do/TuBancoEmpresas/Login.aspx",
  landingUrl: "https://www.banreservas.com.do/TuBancoEmpresas/Default.aspx",
  framework: "aspnet-webforms+devexpress",
  frames: { top: "topFrame", left: "leftFrame", main: "mainFrame", content: "mainFrame" },
  routes: { accounts: "/TuBancoEmpresas/Pages/Accounts/Accounts.aspx", detail: "/TuBancoEmpresas/Pages/Common/ProductStatus.aspx" },
  selectors: {
    accountGrid: "#ctl00_MainHolder_AccountGrid_AccountASPxGridView",
    accountRow: 'tr[id*="_AccountASPxGridView_DXDataRow"].dxgvDataRow',
    productCombo: "#ctl00_MainHolder_cmbProducts",
    nextPage: "#ctl00_MainHolder_AccountTransactionGrid_lnkNext",
    dateFrom: "#ctl00_MainHolder_period_dateTextBoxDateFrom",
    dateTo: "#ctl00_MainHolder_period_dateTextBoxDateTo",
    query: "#ctl00_MainHolder_period_linkButtonConsultar",
    back: "#ctl00_MainHolder_linkButtonBackToFrom1",
    transactionGrid: "#ctl00_MainHolder_AccountTransactionGrid_ASPxGridViewTransactions",
    transactionRow: 'tr[id*="_DXDataRow"].dxgvDataRow',
  },
  columnMapping: { date: 0, transactionNumber: 1, concept: 2, debit: 3, credit: 4, balance: 5 },
  formats: { date: "DD/MM/YY", timezoneOffset: SANTO_DOMINGO_OFFSET, amount: "1,234.56", balancePrefix: "DOP" },
} as const;

export function parseBanreservasEmpresasDate(value: string): string {
  const match = /^(\d{2})\/(\d{2})\/(\d{2})$/.exec(value);
  if (!match) throw new Error("Invalid Banreservas Empresas date format");

  const [, dayText, monthText, yearText] = match;
  const day = Number(dayText);
  const month = Number(monthText);
  const year = 2000 + Number(yearText);
  if (month < 1 || month > 12 || day < 1 || day > new Date(year, month, 0).getDate()) {
    throw new Error("Invalid Banreservas Empresas date format");
  }

  return `${year}-${monthText}-${dayText}T00:00:00${SANTO_DOMINGO_OFFSET}`;
}

export function parseBanreservasEmpresasAmount(value: string): number {
  if (!/^(?:\d+(?:\.\d{1,2})?|(?:0|[1-9]\d{0,2})(?:,\d{3})+(?:\.\d{1,2})?)$/.test(value)) {
    throw new Error("Invalid Banreservas Empresas amount format");
  }

  const amount = Number(value.replace(/,/g, ""));
  if (!Number.isFinite(amount)) throw new Error("Invalid Banreservas Empresas amount format");
  return amount;
}

export function parseBanreservasEmpresasTransactionRows(
  rows: readonly BanreservasEmpresasTransaction[],
  options: BanreservasEmpresasParseOptions = {},
): BankMovement[] {
  return rows.map((row) => {
    const debit = parseBanreservasEmpresasAmount(row.debit);
    const credit = parseBanreservasEmpresasAmount(row.credit);
    if (debit === 0 && credit === 0) throw new Error("Banreservas Empresas parser: missing amount");
    if (debit !== 0 && credit !== 0) throw new Error("Banreservas Empresas parser: ambiguous amount");

    const isDebit = debit !== 0;
    return {
      bankId: banreservasEmpresasBankCode,
      accountFingerprint: options.accountFingerprint ?? DEFAULT_ACCOUNT_FINGERPRINT,
      postedAt: parseBanreservasEmpresasDate(row.date),
      amount: (isDebit ? debit : credit).toFixed(2),
      currency: options.currency ?? "DOP",
      direction: isDebit ? "debit" : "credit",
      reference: normalizeOptionalText(row.transactionNumber),
      concept: normalizeText(row.concept),
      originator: null,
      metadata: null,
    };
  });
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function normalizeOptionalText(value: string): string | null {
  return value.trim() || null;
}
