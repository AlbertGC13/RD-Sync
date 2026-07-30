import type { PopularTransactionRow } from "../../../modules/bank-adapters/popular";
import { popularScraperProfile } from "../../../modules/bank-adapters/popular";

// ---------------------------------------------------------------------------
// Configuration constants sourced from the scraper profile
// ---------------------------------------------------------------------------

const POPULAR_PORTAL_BASE_URL = "https://ib.bpd.com.do";
const POPULAR_DASHBOARD_PATH = "/dashboard";
const POPULAR_TRANSACTIONS_PATH = "/accountdetails/transactions";
const DEFAULT_ITEMS_PER_PAGE = 100;
const DEFAULT_MAX_PAGES = 25;
const RESULTS_WAIT_TEXT = "Fecha posteo";
const RESULTS_WAIT_TIMEOUT_MS = 15_000;
const DASHBOARD_WAIT_TEXT = "Producto";
const DASHBOARD_WAIT_TIMEOUT_MS = 15_000;

// Warm-up and settle defaults
const DEFAULT_WARMUP_PAUSE_MS = 6_000;
const DEFAULT_SETTLE_INTERVAL_MS = 1_500;
const DEFAULT_SETTLE_FLOOR_MS = 8_000;
const DEFAULT_SETTLE_MAX_MS = 25_000;
const SANTO_DOMINGO_TIME_ZONE = "America/Santo_Domingo";
const DAY_MS = 24 * 60 * 60 * 1_000;

export const DEFAULT_SCRAPE_LOOKBACK_DAYS = 7;
const MIN_SCRAPE_LOOKBACK_DAYS = 1;
const MAX_SCRAPE_LOOKBACK_DAYS = 31;
export const SAFE_SUMMARY_POPULAR_PAGINATION_LIMIT_REACHED =
  "La consulta alcanzó el límite de páginas. Intente nuevamente con un rango de fechas más corto.";

// These values come from the profile so the profile stops being dead code.
const ACCOUNT_TYPE = "Corriente";
const CURRENCY = "DOP";
const DASHBOARD_PRODUCT_TEXT = "Corriente";
const DASHBOARD_CURRENCY_TEXT = "RD$";

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
// PopularPortalPage — navigation-only page seam
//
// CONTRACT: This interface intentionally exposes NO type/fill/submit methods.
// The only mutation surface is ONE whitelisted dashboard account-row click
// (openDashboardAccount), which is required for warm-up navigation.
// Navigation is URL-only (goto) plus the single whitelisted click.
// The read-only and navigation-only guarantee is structural: it is impossible
// to trigger form submission or text input through this interface.
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
  /**
   * Click the dashboard products-table row whose Producto cell (index 2) and
   * Moneda cell (index 3) EXACTLY equal the given args.
   * EXACT equality is required — substring matching would hit alias rows like
   * "Ahorros o Corriente" and produce wrong-account results.
   * Resolves false when no row matches.
   */
  openDashboardAccount(productText: string, currencyText: string): Promise<boolean>;
  /**
   * Passive wait for the given number of milliseconds.
   * Used for warm-up settle (after dashboard click) and result settle polling.
   */
  pause(ms: number): Promise<void>;
}

// ---------------------------------------------------------------------------
// collectPopularPortalRows — result type
// ---------------------------------------------------------------------------

export type CollectPopularPortalRowsResult =
  | { kind: "rows"; rows: PopularTransactionRow[] }
  | { kind: "needs_admin_action"; safeErrorSummary: string; cause?: never }
  | { kind: "needs_admin_action"; safeErrorSummary: string; cause: "session_expired" };

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
  const { day, month, year } = getPopularPortalDateParts(date);
  return `${day}/${month}/${year}`;
}

export function parseScrapeLookbackDays(value: string | undefined): number {
  const normalized = value?.trim();
  if (!normalized) return DEFAULT_SCRAPE_LOOKBACK_DAYS;

  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return DEFAULT_SCRAPE_LOOKBACK_DAYS;

  return Math.min(
    MAX_SCRAPE_LOOKBACK_DAYS,
    Math.max(MIN_SCRAPE_LOOKBACK_DAYS, Math.trunc(parsed)),
  );
}

export function resolveScrapeWindow(
  now: Date,
  lookbackDays: number,
): { sDate: Date; eDate: Date } {
  const { day, month, year } = getPopularPortalDateParts(now);
  const eDate = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), 12));
  const normalizedLookbackDays = Number.isFinite(lookbackDays)
    ? Math.min(
      MAX_SCRAPE_LOOKBACK_DAYS,
      Math.max(MIN_SCRAPE_LOOKBACK_DAYS, Math.trunc(lookbackDays)),
    )
    : DEFAULT_SCRAPE_LOOKBACK_DAYS;

  return {
    sDate: new Date(eDate.getTime() - (normalizedLookbackDays - 1) * DAY_MS),
    eDate,
  };
}

function getPopularPortalDateParts(date: Date): {
  day: string;
  month: string;
  year: string;
} {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: SANTO_DOMINGO_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  const parts = fmt.formatToParts(date);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "00";
  return { day: get("day"), month: get("month"), year: get("year") };
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
  /**
   * How long to pause after clicking the dashboard account row before
   * navigating to the transactions URL. Defaults to 6000ms.
   * Pass 0 in tests for fast execution.
   */
  warmupPauseMs?: number;
  /**
   * How long to wait between settle-loop read attempts. Defaults to 1500ms.
   * Pass 0 in tests for fast execution.
   */
  settleIntervalMs?: number;
  /**
   * Minimum elapsed time (ms) before a zero-row result is accepted.
   * Prevents false-empty reads caused by premature table rendering.
   * Defaults to 8000ms. Pass 0 in tests to accept zero rows immediately.
   */
  settleFloorMs?: number;
  /**
   * Maximum elapsed time (ms) for the settle loop before giving up.
   * Defaults to 25000ms.
   */
  settleMaxMs?: number;
}

/**
 * Drives the Popular portal page through a warm-up click and pagination,
 * extracting transaction rows. Returns a discriminated union so callers can
 * handle admin-action states without exceptions.
 *
 * Warm-up phase (before pagination):
 *  1. goto {baseUrl}/dashboard
 *  2. currentUrl() does not include "/dashboard" → needs_admin_action
 *     ("Bank session expired or requires verification")
 *  3. waitForVisibleText("Producto") false → needs_admin_action
 *     ("Bank dashboard did not render")
 *  4. openDashboardAccount("Corriente", "RD$") false → needs_admin_action
 *     ("Bank account row not found on dashboard")
 *  5. pause(warmupPauseMs)
 *
 * Per-page settle loop:
 *  - After waitForVisibleText("Fecha posteo"), poll readResultsTable via
 *    pause(settleIntervalMs) until two consecutive reads have the same
 *    rowCount, with a settleFloorMs minimum before accepting a ZERO-row result.
 *    Non-zero stable counts may be accepted before the floor.
 *    settleMaxMs caps the total settle time.
 *
 * State detection:
 *  - Redirect away from /dashboard during warm-up → needs_admin_action
 *    ("Bank session expired or requires verification")
 *  - "Producto" not visible on dashboard → needs_admin_action
 *    ("Bank dashboard did not render")
 *  - openDashboardAccount returns false → needs_admin_action
 *    ("Bank account row not found on dashboard")
 *  - waitForVisibleText("Fecha posteo") times out and table absent → needs_admin_action
 *    ("Bank portal did not render transaction results")
 *  - Redirect away from transactions path during pagination → needs_admin_action
 *    ("Bank session expired or requires verification")
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
    warmupPauseMs = DEFAULT_WARMUP_PAUSE_MS,
    settleIntervalMs = DEFAULT_SETTLE_INTERVAL_MS,
    settleFloorMs = DEFAULT_SETTLE_FLOOR_MS,
    settleMaxMs = DEFAULT_SETTLE_MAX_MS,
  } = options;

  // ---------------------------------------------------------------------------
  // Warm-up phase: navigate to dashboard and click the Corriente/RD$ row
  // ---------------------------------------------------------------------------

  await page.goto(`${baseUrl}${POPULAR_DASHBOARD_PATH}`);

  const dashboardUrl = await page.currentUrl();
  if (!dashboardUrl.includes(POPULAR_DASHBOARD_PATH)) {
    return {
      kind: "needs_admin_action",
      safeErrorSummary: "Bank session expired or requires verification",
      cause: "session_expired",
    };
  }

  const dashboardReady = await page.waitForVisibleText(DASHBOARD_WAIT_TEXT, DASHBOARD_WAIT_TIMEOUT_MS);
  if (!dashboardReady) {
    return {
      kind: "needs_admin_action",
      safeErrorSummary: "Bank dashboard did not render",
    };
  }

  const accountFound = await page.openDashboardAccount(DASHBOARD_PRODUCT_TEXT, DASHBOARD_CURRENCY_TEXT);
  if (!accountFound) {
    return {
      kind: "needs_admin_action",
      safeErrorSummary: "Bank account row not found on dashboard",
    };
  }

  await page.pause(warmupPauseMs);

  // ---------------------------------------------------------------------------
  // Pagination loop
  // ---------------------------------------------------------------------------

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
        cause: "session_expired",
      };
    }

    // Wait for the results header
    const textVisible = await page.waitForVisibleText(RESULTS_WAIT_TEXT, RESULTS_WAIT_TIMEOUT_MS);
    const snapshot = await settleReadResultsTable(page, {
      settleIntervalMs,
      settleFloorMs,
      settleMaxMs,
    });

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

    if (pageRows.length === itemsPerPage && pageNumber === maxPages) {
      return {
        kind: "needs_admin_action",
        safeErrorSummary: SAFE_SUMMARY_POPULAR_PAGINATION_LIMIT_REACHED,
      };
    }

    // Stop when fewer than a full page was returned
    if (pageRows.length < itemsPerPage) {
      break;
    }
  }

  return { kind: "rows", rows: allRows };
}

// ---------------------------------------------------------------------------
// settleReadResultsTable — settle-loop for premature-read race condition
//
// After "Fecha posteo" becomes visible, the data POST is still in flight.
// We poll readResultsTable until two consecutive reads have the same rowCount.
// A zero-row stable result requires settleFloorMs before being accepted.
// ---------------------------------------------------------------------------

interface SettleOptions {
  settleIntervalMs: number;
  settleFloorMs: number;
  settleMaxMs: number;
}

async function settleReadResultsTable(
  page: PopularPortalPage,
  opts: SettleOptions,
): Promise<PortalTableSnapshot | null> {
  const { settleIntervalMs, settleFloorMs, settleMaxMs } = opts;
  const startMs = Date.now();
  let prevRowCount: number | null = null;
  let latestSnapshot: PortalTableSnapshot | null = null;

  while (true) {
    const snapshot = await page.readResultsTable();
    const rowCount = snapshot?.rows.length ?? 0;
    const elapsedMs = Date.now() - startMs;

    if (prevRowCount !== null && rowCount === prevRowCount) {
      // Stable count observed.
      if (rowCount > 0) {
        // Non-zero stable — accept immediately (before floor).
        return snapshot;
      }
      // Zero stable — only accept after the floor has elapsed.
      if (elapsedMs >= settleFloorMs) {
        return snapshot;
      }
      // Zero stable but floor not yet elapsed — keep polling.
    }

    prevRowCount = rowCount;
    latestSnapshot = snapshot;

    if (elapsedMs >= settleMaxMs) {
      // Timed out — return whatever we have.
      return latestSnapshot;
    }

    await page.pause(settleIntervalMs);
    // Re-check the cap after pausing so the function does not overshoot
    // settleMaxMs by a full interval when elapsed was just under the cap.
    if (Date.now() - startMs >= settleMaxMs) {
      return latestSnapshot;
    }
  }
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
