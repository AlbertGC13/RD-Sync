import {
  parsePopularTransactionRows,
  popularScraperProfile,
} from "../../../modules/bank-adapters/popular";
import type { IngestionScraper } from "../../queues";
import type { ScrapeCollectionResult } from "../../scraper";
import {
  collectPopularPortalRows,
  type CollectPopularPortalRowsResult,
  type PopularPortalPage,
  type PortalTableSnapshot,
} from "./popular";

// ---------------------------------------------------------------------------
// CDP structural interfaces
//
// These are structural (duck-typed) — no type imports from playwright-core at
// the seam. This mirrors the PlaywrightPageLike pattern in src/worker/scraper/index.ts.
// ---------------------------------------------------------------------------

export interface CdpPageLike {
  url(): string;
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  waitForSelector(selector: string, options?: { timeout?: number; state?: string }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  evaluate<T>(fn: (arg?: unknown) => T, arg?: unknown): Promise<T>;
  close(): Promise<void>;
}

export interface CdpContextLike {
  newPage(): Promise<CdpPageLike>;
}

export interface CdpBrowserLike {
  /** Existing contexts of the attached browser; contexts()[0] holds the human session. */
  contexts(): CdpContextLike[];
  newPage(): Promise<CdpPageLike>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// extractResultsTableFromDocument — pure DOM extraction (exported for testing)
//
// Accepts any Document-like value so this logic can be unit-tested with JSDOM
// without a real browser. Called inside page.evaluate() via a closure that
// forwards `document` explicitly.
//
// CRITICAL: scans thead tr > * (both th AND td) so the last two column headers
// ("Ver imagen" and "Detalle") which use <td scope="col"> — not <th> — are
// included. A th-only scan silently drops those headers and misaligns columns
// 8 and 9 for every row.
// ---------------------------------------------------------------------------

export interface DocumentLike {
  querySelector(selector: string): ElementLike | null;
}

export interface ElementLike {
  querySelector(selector: string): ElementLike | null;
  querySelectorAll(selector: string): ArrayLike<ElementLike>;
  textContent: string | null;
}

export function extractResultsTableFromDocument(
  doc: DocumentLike,
): PortalTableSnapshot | null {
  const table = doc.querySelector("table.w-full");
  if (!table) return null;

  const headerCells = Array.from(table.querySelectorAll("thead tr > *"));
  const headers = headerCells.map((cell) => {
    const span = cell.querySelector("span");
    return (span?.textContent ?? cell.textContent ?? "").trim();
  });

  const bodyRows = Array.from(table.querySelectorAll("tbody tr"));
  const rows = bodyRows.map((tr) =>
    Array.from(tr.querySelectorAll("td")).map((td) => ({
      text: (td.textContent ?? "").trim(),
      hasImage: td.querySelector("img") !== null,
    })),
  );

  return { headers, rows };
}

// ---------------------------------------------------------------------------
// CdpPopularPortalPage — adapts a CDP page to the PopularPortalPage seam
// ---------------------------------------------------------------------------

export class CdpPopularPortalPage implements PopularPortalPage {
  constructor(private readonly page: CdpPageLike) {}

  async goto(url: string): Promise<void> {
    await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  }

  async currentUrl(): Promise<string> {
    return this.page.url();
  }

  async waitForVisibleText(text: string, timeoutMs: number): Promise<boolean> {
    try {
      await this.page.waitForSelector(
        `text=${text}`,
        { timeout: timeoutMs, state: "visible" },
      );
      return true;
    } catch {
      return false;
    }
  }

  async readResultsTable(): Promise<PortalTableSnapshot | null> {
    // NOTE: the extraction logic mirrors extractResultsTableFromDocument (exported
    // below for unit testing). Keep the two in sync when modifying either.
    // We must use thead tr > * (both th AND td) to capture all 9 headers.
    // The last two headers (Ver imagen, Detalle) use <td scope="col">,
    // not <th>, so a th-only scan silently misaligns those columns.
    return this.page.evaluate(
      () => {
        const table = document.querySelector("table.w-full");
        if (!table) return null;

        const headerCells = Array.from(
          table.querySelectorAll("thead tr > *"),
        );
        const headers = headerCells.map((cell) => {
          const span = cell.querySelector("span");
          return (span?.textContent ?? cell.textContent ?? "").trim();
        });

        const bodyRows = Array.from(table.querySelectorAll("tbody tr"));
        const rows = bodyRows.map((tr) =>
          Array.from(tr.querySelectorAll("td")).map((td) => ({
            text: (td.textContent ?? "").trim(),
            hasImage: td.querySelector("img") !== null,
          })),
        );

        return { headers, rows };
      },
    ) as Promise<PortalTableSnapshot | null>;
  }

  async openDashboardAccount(productText: string, currencyText: string): Promise<boolean> {
    // Uses page.evaluate with explicit args so the function source never has
    // interpolated strings — the portal values are passed as serialized args.
    return this.page.evaluate(
      (args) => {
        const { product, currency } = args as { product: string; currency: string };
        // Scoped to table.w-full — the dashboard accounts table carries this class
        // (verified live); an unscoped scan could hit an unrelated table whose
        // columns [2]/[3] do not mean Producto/Moneda.
        const rows = document.querySelectorAll("table.w-full tbody tr");
        for (const tr of Array.from(rows)) {
          const cells = tr.querySelectorAll("td");
          const productCell = cells[2]?.textContent?.trim() ?? "";
          const currencyCell = cells[3]?.textContent?.trim() ?? "";
          if (productCell === product && currencyCell === currency) {
            (tr as HTMLElement).click();
            return true;
          }
        }
        return false;
      },
      { product: productText, currency: currencyText },
    ) as Promise<boolean>;
  }

  async pause(ms: number): Promise<void> {
    await this.page.waitForTimeout(ms);
  }
}

// ---------------------------------------------------------------------------
// createPopularCdpScraper — factory
// ---------------------------------------------------------------------------

/**
 * Result of the optional browser-availability check performed before the
 * scraper connects via CDP. When `ok` is false the scraper returns
 * `needs_admin_action` immediately — it never attempts to connect.
 */
export type EnsureBrowserResult =
  | { ok: true }
  | { ok: false; safeErrorSummary: string };

export interface PopularCdpScraperOptions {
  cdpUrl?: string;
  baseUrl?: string;
  itemsPerPage?: number;
  maxPages?: number;
  warmupPauseMs?: number;
  settleIntervalMs?: number;
  settleFloorMs?: number;
  settleMaxMs?: number;
  /**
   * Provides the current date (used for sDate/eDate).
   * Defaults to () => new Date().
   */
  clock?: () => Date;
  /**
   * Optional seam that ensures the CDP-enabled bank browser is running before
   * the scraper attempts to connect. When provided, it is awaited BEFORE
   * `connect`. A failed check short-circuits to `needs_admin_action` with the
   * safe summary — connect is never attempted.
   *
   * When omitted (default), the scraper connects directly as before.
   */
  ensureBrowser?: () => Promise<EnsureBrowserResult>;
  /**
   * Injectable CDP connect function.
   * Defaults to a LAZY DYNAMIC IMPORT of playwright-core chromium.connectOverCDP
   * performed inside collect() so that playwright-core is never loaded at
   * module load time (vitest/build safety).
   */
  connect?: (cdpUrl: string) => Promise<CdpBrowserLike>;
  /**
   * Injectable row collection function (for testing without a real browser).
   * Defaults to collectPopularPortalRows.
   */
  collectRows?: (
    page: PopularPortalPage,
    options: {
      baseUrl: string;
      sDate: Date;
      eDate: Date;
      itemsPerPage?: number;
      maxPages?: number;
      warmupPauseMs?: number;
      settleIntervalMs?: number;
      settleFloorMs?: number;
      settleMaxMs?: number;
    },
  ) => Promise<CollectPopularPortalRowsResult>;
}

const DEFAULT_CDP_URL = "http://127.0.0.1:9222";
// NOTE: This constant is Banco Popular–specific. Do not share it across bank adapters.
const DEFAULT_BASE_URL = "https://ib.bpd.com.do";

/**
 * Creates an IngestionScraper that attaches to an existing human-opened
 * Brave browser session via CDP and reads the Popular portal transactions.
 *
 * Connect is LAZY: playwright-core is dynamically imported inside collect(),
 * never at module load time.
 *
 * Cleanup guarantee: the page this scraper creates is ALWAYS closed in
 * finally, then the Browser handle (which detaches from Brave without
 * closing the human's other windows/tabs).
 */
export function createPopularCdpScraper(options: PopularCdpScraperOptions = {}): IngestionScraper {
  const {
    cdpUrl = DEFAULT_CDP_URL,
    baseUrl = DEFAULT_BASE_URL,
    itemsPerPage,
    maxPages,
    warmupPauseMs,
    settleIntervalMs,
    settleFloorMs,
    settleMaxMs,
    clock = () => new Date(),
    connect = lazyPlaywrightConnect,
    collectRows = collectPopularPortalRows,
    ensureBrowser,
  } = options;

  return {
    async collect(): Promise<ScrapeCollectionResult> {
      let browser: CdpBrowserLike | null = null;
      let cdpPage: CdpPageLike | null = null;

      try {
        // Ensure the CDP-enabled bank browser is running before connecting.
        // A failed check short-circuits to needs_admin_action — connect is
        // never attempted, so no transient CDP error leaks to the employee.
        if (ensureBrowser) {
          const browserCheck = await ensureBrowser();
          if (!browserCheck.ok) {
            return {
              status: "needs_admin_action",
              movements: [],
              safeErrorSummary: browserCheck.safeErrorSummary,
            };
          }
        }

        try {
          browser = await connect(cdpUrl);
        } catch {
          return {
            status: "needs_admin_action",
            movements: [],
            safeErrorSummary: "Bank browser session is not available",
          };
        }

        // The page MUST come from the browser's default context: that context
        // holds the human's logged-in session cookies. browser.newPage() would
        // create a fresh (incognito-like) context that the bank treats as an
        // unauthenticated visitor.
        const defaultContext = browser.contexts()[0];
        cdpPage = defaultContext !== undefined
          ? await defaultContext.newPage()
          : await browser.newPage();
        const portalPage = new CdpPopularPortalPage(cdpPage);

        const today = clock();
        const collectResult = await collectRows(portalPage, {
          baseUrl,
          sDate: today,
          eDate: today,
          itemsPerPage,
          maxPages,
          warmupPauseMs,
          settleIntervalMs,
          settleFloorMs,
          settleMaxMs,
        });

        if (collectResult.kind === "needs_admin_action") {
          return {
            status: "needs_admin_action",
            movements: [],
            safeErrorSummary: collectResult.safeErrorSummary,
          };
        }

        const movements = parsePopularTransactionRows(collectResult.rows, {
          bankId: popularScraperProfile.bankId,
          accountFingerprint: popularScraperProfile.accountFingerprint,
        });

        return { status: "collected", movements };
      } finally {
        // Always close in order: page first, then the CDP Browser handle.
        // Closing the Browser handle detaches from Brave without closing the
        // human's existing windows.
        if (cdpPage !== null) {
          try {
            await cdpPage.close();
          } catch {
            // Ignore page close errors
          }
        }
        if (browser !== null) {
          try {
            await browser.close();
          } catch {
            // Ignore browser handle close errors
          }
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// lazyPlaywrightConnect — default connect implementation
//
// Uses dynamic import so playwright-core is never loaded at module load time.
// This keeps vitest and the Next.js build safe.
// ---------------------------------------------------------------------------

async function lazyPlaywrightConnect(cdpUrl: string): Promise<CdpBrowserLike> {
  const { chromium } = await import("playwright-core");
  // connectOverCDP returns a Browser — it is structurally compatible with CdpBrowserLike.
  return chromium.connectOverCDP(cdpUrl) as Promise<CdpBrowserLike>;
}
