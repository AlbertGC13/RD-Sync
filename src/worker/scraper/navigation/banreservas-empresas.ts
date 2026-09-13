import { createHash } from "node:crypto";

import {
  banreservasEmpresasBankCode,
  parseBanreservasEmpresasTransactionRows,
  type BanreservasEmpresasTransaction,
} from "../../../modules/bank-adapters/banreservas-empresas";
import type { BankMovement } from "../../../modules/transactions";

const SANTO_DOMINGO_OFFSET_MS = -4 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LOOKBACK_DAYS = 30;
const MAX_LOOKBACK_DAYS = 90;
const DEFAULT_MAX_PAGES_PER_ACCOUNT = 100;
const TRANSACTION_CELL_COUNT = 6;
const FINGERPRINT_LENGTH = 10;

const SAFE_SUMMARY_PROTECTED = "Banreservas Empresas session requires administrator action.";
const SAFE_SUMMARY_UNAVAILABLE = "Banreservas Empresas page is unavailable.";
const SAFE_SUMMARY_ACCOUNTS = "Banreservas Empresas accounts are unavailable.";
const SAFE_SUMMARY_MOVEMENTS = "Banreservas Empresas movements are unavailable.";
const SAFE_SUMMARY_PAGING = "Banreservas Empresas movements could not be fully paged.";
const SAFE_SUMMARY_PARSE = "Banreservas Empresas movements could not be safely parsed.";

export type BanreservasEmpresasAccessState = "authenticated" | "login" | "unknown";
/** Portal period bounds formatted as DD/MM/YYYY for the masked date inputs. */
export type BanreservasEmpresasPeriod = Readonly<{ from: string; to: string }>;

/**
 * Narrow main-frame seam. Its only browser mutations are the read-only
 * consultation flow (open accounts, select a row, set the period, query, page).
 * Implementations must never expose transfer, payment, export, or admin actions.
 */
export interface BanreservasEmpresasPage {
  accessState(): Promise<BanreservasEmpresasAccessState>;
  openAccountsQuery(): Promise<boolean>;
  countAccountRows(): Promise<number>;
  selectAccountRow(index: number): Promise<boolean>;
  /** Opaque portal key of the selected account; hashed before it reaches any movement. */
  selectedAccountKey(): Promise<string>;
  setPeriod(period: BanreservasEmpresasPeriod): Promise<boolean>;
  runQuery(): Promise<boolean>;
  /** Direct cells of every visible transaction row, in grid order. */
  readVisibleTransactionRows(): Promise<readonly (readonly string[])[]>;
  hasNextPage(): Promise<boolean>;
  goToNextPage(): Promise<boolean>;
}

export type BanreservasEmpresasCollectionResult =
  | { status: "collected"; movements: BankMovement[] }
  | { status: "needs_admin_action"; movements: []; safeErrorSummary: string }
  | { status: "unavailable"; movements: []; safeErrorSummary: string };

export type BanreservasEmpresasCollectionOptions = Readonly<{
  clock?: () => Date;
  lookbackDays?: number;
  maxPagesPerAccount?: number;
}>;

type PagedRows = { status: "ok"; rows: BanreservasEmpresasTransaction[] } | { status: "failed"; safeErrorSummary: string };

function unavailable(safeErrorSummary: string): BanreservasEmpresasCollectionResult {
  return { status: "unavailable", movements: [], safeErrorSummary };
}

function formatPeriodDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getUTCDate())}/${pad(date.getUTCMonth() + 1)}/${date.getUTCFullYear()}`;
}

/** Resolves the Santo Domingo calendar window ending today with a bounded lookback. */
export function resolveBanreservasEmpresasPeriod(now: Date, lookbackDays: number): BanreservasEmpresasPeriod {
  const days = Number.isFinite(lookbackDays) ? Math.min(MAX_LOOKBACK_DAYS, Math.max(1, Math.floor(lookbackDays))) : DEFAULT_LOOKBACK_DAYS;
  const local = new Date(now.getTime() + SANTO_DOMINGO_OFFSET_MS);
  const end = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  return { from: formatPeriodDate(new Date(end - days * DAY_MS)), to: formatPeriodDate(new Date(end)) };
}

/** Opaque, stable per-account fingerprint; the portal key itself never leaves the collector. */
export function deriveBanreservasEmpresasAccountFingerprint(accountKey: string): string {
  const digest = createHash("sha256").update(`${banreservasEmpresasBankCode}:${accountKey}`).digest("hex");
  return `${banreservasEmpresasBankCode}-${digest.slice(0, FINGERPRINT_LENGTH)}`;
}

function toTransaction(cells: readonly string[]): BanreservasEmpresasTransaction | null {
  if (cells.length !== TRANSACTION_CELL_COUNT || cells.some((cell) => typeof cell !== "string")) return null;
  const [date, transactionNumber, concept, debit, credit, balance] = cells;
  return { date, transactionNumber, concept, debit, credit, balance };
}

/** Pages until the portal shows an empty page or disables Next; a stuck or over-long pager fails closed. */
async function readAllPages(page: BanreservasEmpresasPage, maxPages: number): Promise<PagedRows> {
  const rows = new Map<string, BanreservasEmpresasTransaction>();
  let previousSnapshot: string | undefined;
  for (let pageIndex = 0; ; pageIndex++) {
    if (pageIndex >= maxPages) return { status: "failed", safeErrorSummary: SAFE_SUMMARY_PAGING };
    const visible = await page.readVisibleTransactionRows();
    if (visible.length === 0) break;
    const snapshot = JSON.stringify(visible);
    if (snapshot === previousSnapshot) return { status: "failed", safeErrorSummary: SAFE_SUMMARY_PAGING };
    previousSnapshot = snapshot;
    for (const cells of visible) {
      const row = toTransaction(cells);
      if (!row) return { status: "failed", safeErrorSummary: SAFE_SUMMARY_PARSE };
      rows.set(JSON.stringify(row), row);
    }
    if (!(await page.hasNextPage())) break;
    if (!(await page.goToNextPage())) return { status: "failed", safeErrorSummary: SAFE_SUMMARY_PAGING };
  }
  return { status: "ok", rows: [...rows.values()] };
}

export async function collectBanreservasEmpresasMovements(
  page: BanreservasEmpresasPage,
  options: BanreservasEmpresasCollectionOptions = {},
): Promise<BanreservasEmpresasCollectionResult> {
  const clock = options.clock ?? (() => new Date());
  const maxPages = options.maxPagesPerAccount ?? DEFAULT_MAX_PAGES_PER_ACCOUNT;
  try {
    const accessState = await page.accessState();
    if (accessState === "login") return { status: "needs_admin_action", movements: [], safeErrorSummary: SAFE_SUMMARY_PROTECTED };
    if (accessState !== "authenticated") return unavailable(SAFE_SUMMARY_UNAVAILABLE);
    if (!(await page.openAccountsQuery())) return unavailable(SAFE_SUMMARY_ACCOUNTS);

    const accountCount = await page.countAccountRows();
    if (!Number.isInteger(accountCount) || accountCount <= 0) return unavailable(SAFE_SUMMARY_ACCOUNTS);
    const period = resolveBanreservasEmpresasPeriod(clock(), options.lookbackDays ?? DEFAULT_LOOKBACK_DAYS);

    const movements: BankMovement[] = [];
    for (let index = 0; index < accountCount; index++) {
      if (index > 0 && !(await page.openAccountsQuery())) return unavailable(SAFE_SUMMARY_ACCOUNTS);
      if (!(await page.selectAccountRow(index))) return unavailable(SAFE_SUMMARY_ACCOUNTS);
      const accountKey = (await page.selectedAccountKey()).trim();
      if (!accountKey) return unavailable(SAFE_SUMMARY_ACCOUNTS);
      if (!(await page.setPeriod(period)) || !(await page.runQuery())) return unavailable(SAFE_SUMMARY_MOVEMENTS);

      const paged = await readAllPages(page, maxPages);
      if (paged.status !== "ok") return unavailable(paged.safeErrorSummary);
      try {
        movements.push(...parseBanreservasEmpresasTransactionRows(paged.rows, { accountFingerprint: deriveBanreservasEmpresasAccountFingerprint(accountKey) }));
      } catch {
        return unavailable(SAFE_SUMMARY_PARSE);
      }
    }
    return { status: "collected", movements };
  } catch {
    return unavailable(SAFE_SUMMARY_MOVEMENTS);
  }
}
