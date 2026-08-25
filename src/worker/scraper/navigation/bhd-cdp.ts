import type { IngestionScraper } from "../../queues";
import type { ScrapeCollectionResult } from "../index";
import { collectBhdPersonalMovements, type BhdPersonalAccessState, type BhdPersonalPage } from "./bhd";
import { createBhdPersonalReadonlySessionChecker, type BhdPersonalSessionPageObservation } from "../bhd-personal-session-checker";
import type { ReadonlySessionChecker } from "../authenticated-session-probe";

const SAFE_SUMMARY = "BHD Personal observation requires administrator action.";
const PRODUCT_URL = "https://ibp.bhd.com.do/#/bhd/product-detail";
const LOOPBACK_CDP = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):([1-9]\d{0,4})$/;

export interface BhdCdpPage {
  url(): string;
  evaluate<Result>(pageFunction: () => Result): Promise<Result>;
}

export interface BhdCdpBrowser {
  contexts(): readonly { pages(): readonly BhdCdpPage[] }[];
  close(): Promise<void>;
}

export type BhdPersonalCdpScraperOptions = Readonly<{
  cdpUrl?: string;
  connect?: (cdpUrl: string) => Promise<BhdCdpBrowser>;
}>;

function validCdpEndpoint(value: string | undefined): value is string {
  if (typeof value !== "string" || value !== value.trim()) return false;
  const match = LOOPBACK_CDP.exec(value);
  return match !== null && Number(match[1]) <= 65_535;
}

function trustedProductUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.href === PRODUCT_URL && !url.username && !url.password;
  } catch {
    return false;
  }
}

async function lazyConnect(cdpUrl: string): Promise<BhdCdpBrowser> {
  const { chromium } = await import("playwright-core");
  return chromium.connectOverCDP(cdpUrl) as unknown as BhdCdpBrowser;
}

/** A narrow CDP page wrapper with only the read/collection seams BHD needs. */
export class CdpBhdPersonalPage implements BhdPersonalPage, BhdPersonalSessionPageObservation {
  constructor(private readonly page: BhdCdpPage) {}

  async currentUrl(): Promise<string> { return this.page.url(); }

  async accessState(): Promise<BhdPersonalAccessState> {
    const state: string = await this.page.evaluate(() => {
      if (document.querySelector("input[type='password'], form[action*='login']")) return "login";
      if (document.querySelector("iframe[src*='captcha'], [data-protected-flow]")) return "protected";
      return document.querySelector("table.p-datatable-table, button.bhd-btn-primary") ? "authenticated" : "unknown";
    });
    return state === "authenticated" || state === "login" || state === "security_question" || state === "protected" ? state : "unknown";
  }

  async hasAuthenticatedMarker(): Promise<boolean> {
    return this.page.evaluate(() => document.querySelector("table.p-datatable-table, button.bhd-btn-primary") !== null);
  }

  async hasLoginPageEvidence(): Promise<boolean> {
    return this.page.evaluate(() => document.querySelector("input[type='password'], form[action*='login']") !== null);
  }

  async isMovementPanelOpen(): Promise<boolean> {
    return this.page.evaluate(() => document.querySelector("table.p-datatable-table") !== null);
  }

  async expandMovementPanel(): Promise<boolean> {
    return this.page.evaluate(() => {
      const button = document.querySelector<HTMLButtonElement>("button.bhd-btn-primary");
      if (!button) return false;
      button.click();
      return true;
    });
  }

  async readVisibleMovementRows(): Promise<readonly (readonly string[])[]> {
    return this.page.evaluate(() => Array.from(document.querySelectorAll("table.p-datatable-table tr.body-responsive"), (row) =>
      Array.from(row.querySelectorAll("td"), (cell) => (cell.textContent ?? "").trim()),
    ));
  }

  async scrollMovementTable(): Promise<boolean> {
    return this.page.evaluate(() => {
      const table = document.querySelector<HTMLElement>(".p-datatable-scrollable");
      if (!table || table.scrollTop + table.clientHeight >= table.scrollHeight) return false;
      table.scrollTop = table.scrollHeight;
      return true;
    });
  }
}

function manualAction(): ScrapeCollectionResult {
  return { status: "needs_admin_action", movements: [], safeErrorSummary: SAFE_SUMMARY };
}

/** Attaches only to an already-open exact BHD Personal product-detail tab. */
export function createBhdPersonalCdpScraper(options: BhdPersonalCdpScraperOptions = {}): IngestionScraper {
  const connect = options.connect ?? lazyConnect;
  return Object.freeze({
    async collect(): Promise<ScrapeCollectionResult> {
      if (!validCdpEndpoint(options.cdpUrl)) return manualAction();
      let browser: BhdCdpBrowser | undefined;
      try {
        browser = await connect(options.cdpUrl);
        const page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => trustedProductUrl(candidate.url()));
        if (!page) return manualAction();
        const result = await collectBhdPersonalMovements(new CdpBhdPersonalPage(page));
        return result.status === "collected" ? result : manualAction();
      } catch {
        return manualAction();
      } finally {
        if (browser) try { await browser.close(); } catch { /* CDP detach must not change the safe result. */ }
      }
    },
  });
}

/** Observes a BHD session through the same attached read-only page adapter. */
export function createBhdPersonalCdpSessionChecker(cdpUrl: string, connect = lazyConnect): ReadonlySessionChecker {
  return Object.freeze({
    async check() {
      const unavailable = { status: "browser_unavailable" as const, checkedAt: new Date().toISOString(), safeSummary: "BHD Personal session is unavailable." };
      if (!validCdpEndpoint(cdpUrl)) return unavailable;
      let browser: BhdCdpBrowser | undefined;
      try {
        browser = await connect(cdpUrl);
        const page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => trustedProductUrl(candidate.url()));
        return page ? await createBhdPersonalReadonlySessionChecker({ page: new CdpBhdPersonalPage(page) }).check() : unavailable;
      } catch {
        return unavailable;
      } finally {
        if (browser) try { await browser.close(); } catch { /* CDP detach must not change the safe result. */ }
      }
    },
  });
}
