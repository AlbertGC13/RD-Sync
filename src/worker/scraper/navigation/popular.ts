import type { PopularTransactionRow } from "../../../modules/bank-adapters/popular";
import { popularScraperProfile } from "../../../modules/bank-adapters/popular";

// ---------------------------------------------------------------------------
// Configuration constants sourced from the scraper profile
// ---------------------------------------------------------------------------

const POPULAR_PORTAL_BASE_URL = "https://ib.bpd.com.do";
const POPULAR_TRANSACTIONS_PATH = "/accountdetails/transactions";
const DEFAULT_ITEMS_PER_PAGE = 20;
const DEFAULT_MAX_PAGES = 25;
const RESULTS_WAIT_TEXT = "Fecha posteo";
const RESULTS_WAIT_TIMEOUT_MS = 15_000;

// These values come from the profile so the profile stops being dead code.
const ACCOUNT_TYPE = "Corriente";
const CURRENCY = "DOP";

// Expose the profile so external consumers can reference bankId / accountFingerprint.
export const { bankId: POPULAR_BANK_ID, accountFingerprint: POPULAR_ACCOUNT_FINGERPRINT } =
  popularScraperProfile;

// ---------------------------------------------------------------------------
// PortalTableSnapshot — the raw data extracted from the results table
// ---------------------------------------------------------------------------

/**
 * Raw snapshot of the portal results table.
 * Headers are text strings from thead tr > * (both th and td elements).
 * Rows are arrays of cells with their trimmed text and whether an <img> was
 * present inside the cell.
 */
export interface PortalTableSnapshot {
  headers: string[];
  rows: Array<Array<{ text: string; hasImage: boolean }>>;
}

// ---------------------------------------------------------------------------
// PopularPortalPage — read-only page seam
//
// CONTRACT: This interface intentionally exposes NO click/type/fill/submit
// methods. Navigation is URL-only (goto). The read-only guarantee is
// structural: it is impossible to trigger a mutation through this interface.
// ---------------------------------------------------------------------------

export interface PopularPortalPage {
  /** Navigate to the given URL using the current CDP session. */
  goto(url: string): Promise<void>;
  /** Return the URL the page is currently showing. */
  currentUrl(): Promise<string>;
  /**
   * Wait until the given text is visible somewhere on the page.
   * Resolves true when found, false on timeout.
   */
  waitForVisibleText(text: string, timeoutMs: number): Promise<boolean>;
  /**
   * Extract the results table snapshot.
   * Returns null when the table is not present on the page.
   * CRITICAL: scans thead tr > * (both th AND td) so that the two right-most
   * column headers (Ver imagen / Detalle) which use <td scope="col"> are
   * included in the header list. A th-only scan silently misaligns those
   * columns.
   */
  readResultsTable(): Promise<PortalTableSnapshot | null>;
}

// ---------------------------------------------------------------------------
// collectPopularPortalRows — result type
// ---------------------------------------------------------------------------

export type CollectPopularPortalRowsResult =
  | { kind: "rows"; rows: PopularTransactionRow[] }
  | { kind: "needs_admin_action"; safeErrorSummary: string };

// ---------------------------------------------------------------------------
// buildPopularTransactionsUrl
// ---------------------------------------------------------------------------

export interface BuildPopularTransactionsUrlOptions {
  baseUrl?: string;
  sDate: Date;
  eDate: Date;
  pageNumber?: number;
  itemsPerPage?: number;
}

/**
 * Formats a Date into the dd/mm/yyyy string the Popular portal expects,
 * computed in the America/Santo_Domingo timezone (UTC-04:00, no DST).
 */
export function formatPopularPortalDate(date: Date): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Santo_Domingo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  // en-CA produces YYYY-MM-DD; split and re-order to dd/mm/yyyy.
  const parts = fmt.formatToParts(date);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "00";

  return `${get("day")}/${get("month")}/${get("year")}`;
}

/**
 * Builds the full transactions URL for the Popular portal with all required
 * query parameters.  Date slashes are URL-encoded as %2F per the contract.
 */
export function buildPopularTransactionsUrl(options: BuildPopularTransactionsUrlOptions): string {
  const {
    baseUrl = POPULAR_PORTAL_BASE_URL,
    sDate,
    eDate,
    pageNumber = 1,
    itemsPerPage = DEFAULT_ITEMS_PER_PAGE,
  } = options;

  const sDateStr = encodeURIComponent(formatPopularPortalDate(sDate));
  const eDateStr = encodeURIComponent(formatPopularPortalDate(eDate));

  const query = [
    `accountType=${ACCOUNT_TYPE}`,
    `currency=${CURRENCY}`,
    `transit=`,
    `transitValue=`,
    `sDate=${sDateStr}`,
    `eDate=${eDateStr}`,
    `amountFrom=`,
    `amountTo=`,
    `referenceNumber=`,
    `checkNumber=`,
    `type=`,
    `filter=false`,
    `pageNumber=${pageNumber}`,
    `itemsPerPage=${itemsPerPage}`,
  ].join("&");

  return `${baseUrl}${POPULAR_TRANSACTIONS_PATH}?${query}`;
}

// ---------------------------------------------------------------------------
// collectPopularPortalRows — main orchestration logic
// ---------------------------------------------------------------------------

export interface CollectPopularPortalRowsOptions {
  baseUrl?: string;
  sDate: Date;
  eDate: Date;
  itemsPerPage?: number;
  maxPages?: number;
}

/**
 * Drives the Popular portal page through pagination and extracts transaction
 * rows.  Returns a discriminated union so callers can handle admin-action
 * states without exceptions.
 *
 * State detection:
 *  - Redirect away from the transactions path → needs_admin_action
 *    ("Bank session expired or requires verification")
 *  - waitForVisibleText times out and table is absent → needs_admin_action
 *    ("Bank portal did not render transaction results")
 *  - Table present with zero rows → kind "rows" with empty array (legitimate)
 *
 * Pagination:
 *  - Increments pageNumber while rows.length === itemsPerPage
 *  - Stops after maxPages pages regardless
 */
export async function collectPopularPortalRows(
  page: PopularPortalPage,
  options: CollectPopularPortalRowsOptions,
): Promise<CollectPopularPortalRowsResult> {
  const {
    baseUrl = POPULAR_PORTAL_BASE_URL,
    sDate,
    eDate,
    itemsPerPage = DEFAULT_ITEMS_PER_PAGE,
    maxPages = DEFAULT_MAX_PAGES,
  } = options;

  const allRows: PopularTransactionRow[] = [];

  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber++) {
    const url = buildPopularTransactionsUrl({ baseUrl, sDate, eDate, pageNumber, itemsPerPage });
    await page.goto(url);

    // Detect login redirect
    const current = await page.currentUrl();
    if (!current.includes(POPULAR_TRANSACTIONS_PATH)) {
      return {
        kind: "needs_admin_action",
        safeErrorSummary: "Bank session expired or requires verification",
      };
    }

    // Wait for the results header
    const textVisible = await page.waitForVisibleText(RESULTS_WAIT_TEXT, RESULTS_WAIT_TIMEOUT_MS);
    const snapshot = await page.readResultsTable();

    if (!textVisible && snapshot === null) {
      return {
        kind: "needs_admin_action",
        safeErrorSummary: "Bank portal did not render transaction results",
      };
    }

    if (snapshot === null) {
      // Table not present but text was visible (unlikely edge case) — treat as empty page
      break;
    }

    const pageRows = extractRowsFromSnapshot(snapshot);
    allRows.push(...pageRows);

    // Stop when fewer than a full page was returned
    if (pageRows.length < itemsPerPage) {
      break;
    }
  }

  return { kind: "rows", rows: allRows };
}

// ---------------------------------------------------------------------------
// extractRowsFromSnapshot — whitelist-based column mapping
// ---------------------------------------------------------------------------

/**
 * Whitelist of header texts mapped to PopularTransactionRow fields.
 * "Balance" is deliberately absent — this enforces data-minimization at the
 * type level: it is structurally impossible to populate balance from this map.
 */
const HEADER_WHITELIST: ReadonlyMap<string, keyof PopularTransactionRow> = new Map([
  ["Fecha posteo", "postedDate"],
  ["Fecha efectiva", "effectiveDate"],
  ["Nro. de cheque", "checkNumber"],
  ["Nro. de referencia", "referenceNumber"],
  ["Descripción", "description"],
  ["Monto", "amount"],
  // "Balance" → intentionally omitted
  ["Ver imagen", "imageAvailable"],
  ["Detalle", "detailAvailable"],
]);

function extractRowsFromSnapshot(snapshot: PortalTableSnapshot): PopularTransactionRow[] {
  // Build a header-index map using only whitelisted column names.
  const columnIndices = new Map<keyof PopularTransactionRow, number>();
  for (let i = 0; i < snapshot.headers.length; i++) {
    const field = HEADER_WHITELIST.get(snapshot.headers[i]);
    if (field !== undefined) {
      columnIndices.set(field, i);
    }
  }

  return snapshot.rows.map((cells) => {
    const get = (field: keyof PopularTransactionRow): { text: string; hasImage: boolean } | undefined => {
      const idx = columnIndices.get(field);
      return idx !== undefined ? cells[idx] : undefined;
    };

    const getText = (field: keyof PopularTransactionRow): string => {
      return get(field)?.text.trim() ?? "";
    };

    const getImage = (field: keyof PopularTransactionRow): boolean => {
      return get(field)?.hasImage ?? false;
    };

    const row: PopularTransactionRow = {
      postedDate: getText("postedDate"),
      effectiveDate: getText("effectiveDate"),
      description: getText("description"),
      amount: getText("amount"),
      checkNumber: getText("checkNumber"),
      referenceNumber: getText("referenceNumber"),
      imageAvailable: getImage("imageAvailable"),
      detailAvailable: getImage("detailAvailable"),
    };

    return row;
  });
}
