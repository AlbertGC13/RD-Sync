import {
  parseBhdTransactionRows,
  type BhdPersonalTransaction,
} from "../../../modules/bank-adapters/bhd";
import type { BankMovement } from "../../../modules/transactions";

const BHD_PERSONAL_ORIGIN = "https://ibp.bhd.com.do";
const BHD_PRODUCT_DETAIL_HASH = "#/bhd/product-detail";
const MAX_SCROLL_READS = 3;

const SAFE_SUMMARY_UNAVAILABLE = "BHD Personal page is unavailable.";
const SAFE_SUMMARY_PROTECTED = "BHD Personal session requires administrator action.";
const SAFE_SUMMARY_MOVEMENTS_UNAVAILABLE = "BHD Personal movements are unavailable.";
const SAFE_SUMMARY_PARSE_FAILURE = "BHD Personal movements could not be safely parsed.";

export type BhdPersonalAccessState = "authenticated" | "login" | "security_question" | "protected" | "unknown";

/**
 * Narrow page seam: its only browser mutation is the known movements-panel
 * expansion. Implementations must not expose form or credential operations.
 */
export interface BhdPersonalPage {
  currentUrl(): Promise<string>;
  accessState(): Promise<BhdPersonalAccessState>;
  isMovementPanelOpen(): Promise<boolean>;
  expandMovementPanel(): Promise<boolean>;
  readVisibleMovementRows(): Promise<readonly (readonly string[])[]>;
  scrollMovementTable(): Promise<boolean>;
}

export type BhdPersonalCollectionResult =
  | { status: "collected"; movements: BankMovement[] }
  | { status: "needs_admin_action"; movements: []; safeErrorSummary: string }
  | { status: "unavailable"; movements: []; safeErrorSummary: string };

export async function collectBhdPersonalMovements(page: BhdPersonalPage): Promise<BhdPersonalCollectionResult> {
  try {
    if (!isTrustedBhdProductDetailUrl(await page.currentUrl())) return unavailable(SAFE_SUMMARY_UNAVAILABLE);

    const accessState = await page.accessState();
    if (accessState === "login" || accessState === "security_question" || accessState === "protected") {
      return { status: "needs_admin_action", movements: [], safeErrorSummary: SAFE_SUMMARY_PROTECTED };
    }
    if (accessState !== "authenticated") return unavailable(SAFE_SUMMARY_UNAVAILABLE);

    if (!(await page.isMovementPanelOpen()) && !(await page.expandMovementPanel())) {
      return unavailable(SAFE_SUMMARY_MOVEMENTS_UNAVAILABLE);
    }

    const rows = await readStableRows(page);
    if (rows === null) return unavailable(SAFE_SUMMARY_PARSE_FAILURE);

    try {
      return { status: "collected", movements: parseBhdTransactionRows(rows) };
    } catch {
      return unavailable(SAFE_SUMMARY_PARSE_FAILURE);
    }
  } catch {
    return unavailable(SAFE_SUMMARY_MOVEMENTS_UNAVAILABLE);
  }
}

function isTrustedBhdProductDetailUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === BHD_PERSONAL_ORIGIN
      && !url.username
      && !url.password
      && url.hash === BHD_PRODUCT_DETAIL_HASH;
  } catch {
    return false;
  }
}

async function readStableRows(page: BhdPersonalPage): Promise<BhdPersonalTransaction[] | null> {
  const rows = new Map<string, BhdPersonalTransaction>();
  let previousSnapshot: string | undefined;

  for (let readCount = 0; readCount < MAX_SCROLL_READS; readCount++) {
    const visibleRows = await page.readVisibleMovementRows();
    if (visibleRows.length === 0 && readCount === 0) return [];

    for (const cells of visibleRows) {
      const row = toBhdPersonalTransaction(cells);
      if (!row) return null;
      rows.set(JSON.stringify(row), row);
    }

    const snapshot = JSON.stringify(visibleRows);
    if (snapshot === previousSnapshot) return [...rows.values()];
    if (readCount === MAX_SCROLL_READS - 1) return null;
    previousSnapshot = snapshot;
    if (!(await page.scrollMovementTable())) return [...rows.values()];
  }

  return [...rows.values()];
}

function toBhdPersonalTransaction(cells: readonly string[]): BhdPersonalTransaction | null {
  if (cells.length !== 7 || cells.some((cell) => typeof cell !== "string")) return null;
  return {
    date: cells[0],
    confirmationNumber: cells[1],
    description: cells[2],
    receipt: cells[3],
    debit: cells[4],
    credit: cells[5],
    balance: cells[6],
  };
}

function unavailable(safeErrorSummary: string): BhdPersonalCollectionResult {
  return { status: "unavailable", movements: [], safeErrorSummary };
}
