import type { IngestionScraper } from "../../queues";
import type { ScrapeCollectionResult } from "../index";
import type { ReadonlySessionChecker } from "../authenticated-session-probe";
import { banreservasEmpresasPortalProfile } from "../../../modules/bank-adapters/banreservas-empresas";
import {
  banreservasEmpresasFramesetPath,
  banreservasEmpresasLoginPath,
  banreservasEmpresasTrustedPath,
  createBanreservasEmpresasReadonlySessionChecker,
  type BanreservasEmpresasFrameName,
  type BanreservasEmpresasFrameObservation,
} from "../banreservas-empresas-session-checker";
import {
  collectBanreservasEmpresasMovements,
  type BanreservasEmpresasAccessState,
  type BanreservasEmpresasPage,
  type BanreservasEmpresasPeriod,
} from "./banreservas-empresas";

/** Canonical isolated loopback endpoint launched by scripts/launch-bank-browser for this portal. */
export const BANRESERVAS_EMPRESAS_CDP_URL = "http://127.0.0.1:9225";
export const BANRESERVAS_EMPRESAS_CDP_URL_ENV = "RD_SYNC_BANK_BANRESERVAS_EMPRESAS_CDP_URL";
const LOOPBACK_CDP = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):([1-9]\d{0,4})$/;
const SAFE_SUMMARY_UNAVAILABLE = "Banreservas Empresas session is unavailable.";
const SAFE_SUMMARY_MANUAL = "Banreservas Empresas observation requires administrator action.";
const { routes, selectors } = banreservasEmpresasPortalProfile;
const PORTAL_ORIGIN = new URL(banreservasEmpresasPortalProfile.landingUrl).origin;
const DEFAULT_SETTLE_TIMEOUT_MS = 45_000;
const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000;
const POSTBACK_START_DELAY_MS = 500;
const POLL_INTERVAL_MS = 250;
const TYPE_DELAY_MS = 20;

export interface BanreservasCdpFrame {
  name(): string;
  url(): string;
  evaluate<Result>(pageFunction: () => Result): Promise<Result>;
}

/** The main frame is the only frame the collector drives; the seam stays free of playwright types. */
export interface BanreservasCdpMainFrame extends BanreservasCdpFrame {
  evaluate<Result>(pageFunction: () => Result): Promise<Result>;
  evaluate<Result, Arg>(pageFunction: (arg: Arg) => Result, arg: Arg): Promise<Result>;
  goto(url: string, options?: { waitUntil?: "load" | "domcontentloaded"; timeout?: number }): Promise<unknown>;
  click(selector: string, options?: { timeout?: number }): Promise<void>;
  press(selector: string, key: string, options?: { timeout?: number }): Promise<void>;
  type(selector: string, text: string, options?: { delay?: number; timeout?: number }): Promise<void>;
  waitForSelector(selector: string, options?: { timeout?: number; state?: "attached" | "visible" }): Promise<unknown>;
}

export interface BanreservasCdpPage<Frame extends BanreservasCdpFrame = BanreservasCdpFrame> {
  url(): string;
  frames(): readonly Frame[];
}

export interface BanreservasCdpBrowser<Frame extends BanreservasCdpFrame = BanreservasCdpFrame> {
  contexts(): readonly { pages(): readonly BanreservasCdpPage<Frame>[] }[];
  close(): Promise<void>;
}

export type BanreservasCdpConnect<Frame extends BanreservasCdpFrame = BanreservasCdpFrame> = (cdpUrl: string) => Promise<BanreservasCdpBrowser<Frame>>;

export function validCdpEndpoint(value: string | undefined): value is string {
  if (typeof value !== "string" || value !== value.trim()) return false;
  const match = LOOPBACK_CDP.exec(value);
  return match !== null && Number(match[1]) <= 65_535;
}

/**
 * Resolves this portal's explicit endpoint only. The Popular/global
 * RD_SYNC_CDP_URL is never consulted, and a malformed override fails closed.
 */
export function resolveBanreservasEmpresasCdpUrl(env: Record<string, string | undefined> = process.env): string | undefined {
  const override = env[BANRESERVAS_EMPRESAS_CDP_URL_ENV];
  if (override === undefined || override.trim() === "") return BANRESERVAS_EMPRESAS_CDP_URL;
  return validCdpEndpoint(override) ? override : undefined;
}

async function lazyConnect(cdpUrl: string): Promise<BanreservasCdpBrowser<BanreservasCdpMainFrame>> {
  const { chromium } = await import("playwright-core");
  return chromium.connectOverCDP(cdpUrl) as unknown as BanreservasCdpBrowser<BanreservasCdpMainFrame>;
}

/** Frame-scoped read-only adapter: only routes and two boolean DOM probes leave the page. */
export class CdpBanreservasEmpresasFrames implements BanreservasEmpresasFrameObservation {
  constructor(private readonly page: BanreservasCdpPage) {}

  async currentUrl(): Promise<string> { return this.page.url(); }

  async frameUrl(name: BanreservasEmpresasFrameName): Promise<string | undefined> {
    return this.page.frames().find((frame) => frame.name() === name)?.url();
  }

  async hasAuthenticatedHeaderMarker(): Promise<boolean> {
    const header = this.page.frames().find((frame) => frame.name() === "topFrame");
    return header ? header.evaluate(() => document.querySelector("a[href*='Logout.aspx']") !== null) : false;
  }

  async hasLoginPageEvidence(): Promise<boolean> {
    const loginFrames = this.page.frames().filter((frame) => banreservasEmpresasTrustedPath(frame.url()) === banreservasEmpresasLoginPath);
    for (const frame of loginFrames) {
      if (await frame.evaluate(() => document.querySelector("input[type='password']") !== null)) return true;
    }
    return false;
  }
}

export type CdpBanreservasEmpresasPageDependencies = Readonly<{
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  settleTimeoutMs?: number;
  navigationTimeoutMs?: number;
}>;

type AsyncPostbackWindow = { Sys?: { WebForms?: { PageRequestManager?: { getInstance(): { get_isInAsyncPostBack(): boolean } } } } };

/**
 * Main-frame adapter for the consultation flow. It clicks only the account
 * row, the period inputs, Consultar, and the custom Next link; export,
 * transfer, payment, and administrative controls are never addressed.
 */
export class CdpBanreservasEmpresasPage implements BanreservasEmpresasPage {
  private readonly frames: CdpBanreservasEmpresasFrames;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly settleTimeoutMs: number;
  private readonly navigationTimeoutMs: number;

  constructor(private readonly page: BanreservasCdpPage<BanreservasCdpMainFrame>, deps: CdpBanreservasEmpresasPageDependencies = {}) {
    this.frames = new CdpBanreservasEmpresasFrames(page);
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = deps.now ?? Date.now;
    this.settleTimeoutMs = deps.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS;
    this.navigationTimeoutMs = deps.navigationTimeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS;
  }

  private mainFrame(): BanreservasCdpMainFrame {
    const frame = this.page.frames().find((candidate) => candidate.name() === "mainFrame");
    if (!frame) throw new Error("Banreservas Empresas main frame is unavailable");
    return frame;
  }

  private mainPath(): string | undefined {
    return banreservasEmpresasTrustedPath(this.page.frames().find((candidate) => candidate.name() === "mainFrame")?.url());
  }

  async accessState(): Promise<BanreservasEmpresasAccessState> {
    const { status } = await createBanreservasEmpresasReadonlySessionChecker({ page: this.frames }).check() as { status?: string };
    return status === "active" ? "authenticated" : status === "expired" ? "login" : "unknown";
  }

  async openAccountsQuery(): Promise<boolean> {
    const main = this.mainFrame();
    await main.goto(`${PORTAL_ORIGIN}${routes.accounts}`, { waitUntil: "load", timeout: this.navigationTimeoutMs });
    await main.waitForSelector(selectors.accountGrid, { timeout: this.navigationTimeoutMs, state: "attached" });
    return this.mainPath() === routes.accounts;
  }

  async countAccountRows(): Promise<number> {
    return this.mainFrame().evaluate((selector) => document.querySelectorAll(selector).length, `${selectors.accountGrid} ${selectors.accountRow}`);
  }

  async selectAccountRow(index: number): Promise<boolean> {
    const main = this.mainFrame();
    await main.click(`${selectors.accountGrid}_DXDataRow${index} > td:first-child`, { timeout: this.navigationTimeoutMs });
    if (!(await this.waitForMainPath(routes.detail))) return false;
    await main.waitForSelector(selectors.transactionGrid, { timeout: this.navigationTimeoutMs, state: "attached" });
    return true;
  }

  async selectedAccountKey(): Promise<string> {
    return this.mainFrame().evaluate((selector) => document.querySelector<HTMLSelectElement>(selector)?.value ?? "", selectors.productCombo);
  }

  async setPeriod(period: BanreservasEmpresasPeriod): Promise<boolean> {
    const main = this.mainFrame();
    for (const [selector, value] of [[selectors.dateFrom, period.from], [selectors.dateTo, period.to]] as const) {
      await main.click(selector, { timeout: this.navigationTimeoutMs });
      await main.press(selector, "Control+a");
      await main.type(selector, value.replace(/\//g, ""), { delay: TYPE_DELAY_MS });
      await main.press(selector, "Tab");
    }
    const typed = await main.evaluate((inputs) => inputs.map((input) => document.querySelector<HTMLInputElement>(input)?.value ?? ""), [selectors.dateFrom, selectors.dateTo]);
    return typed[0] === period.from && typed[1] === period.to;
  }

  async runQuery(): Promise<boolean> {
    await this.mainFrame().click(selectors.query, { timeout: this.navigationTimeoutMs });
    return this.settleAsyncPostback();
  }

  async readVisibleTransactionRows(): Promise<readonly (readonly string[])[]> {
    return this.mainFrame().evaluate((selector) => Array.from(document.querySelectorAll(selector), (row) =>
      Array.from(row.children).filter((cell) => cell.tagName === "TD").map((cell) => (cell.textContent ?? "").replace(/\s+/g, " ").trim()),
    ), `${selectors.transactionGrid} ${selectors.transactionRow}`);
  }

  async hasNextPage(): Promise<boolean> {
    return this.mainFrame().evaluate((selector) => {
      const link = document.querySelector(selector);
      return link !== null && link.hasAttribute("href") && !link.classList.contains("aspNetDisabled");
    }, selectors.nextPage);
  }

  async goToNextPage(): Promise<boolean> {
    await this.mainFrame().click(selectors.nextPage, { timeout: this.navigationTimeoutMs });
    return this.settleAsyncPostback();
  }

  private async waitForMainPath(path: string): Promise<boolean> {
    const deadline = this.now() + this.navigationTimeoutMs;
    while (this.mainPath() !== path) {
      if (this.now() >= deadline) return false;
      await this.sleep(POLL_INTERVAL_MS);
    }
    return true;
  }

  /** Consultar and Next run ASP.NET UpdatePanel postbacks; wait for the PageRequestManager to go idle. */
  private async settleAsyncPostback(): Promise<boolean> {
    await this.sleep(POSTBACK_START_DELAY_MS);
    const deadline = this.now() + this.settleTimeoutMs;
    while (this.now() < deadline) {
      const busy = await this.mainFrame().evaluate(() => {
        try {
          return (window as AsyncPostbackWindow).Sys?.WebForms?.PageRequestManager?.getInstance().get_isInAsyncPostBack() ?? false;
        } catch {
          return false;
        }
      });
      if (!busy) return true;
      await this.sleep(POLL_INTERVAL_MS);
    }
    return false;
  }
}

function findTrustedPortalPage<Frame extends BanreservasCdpFrame>(browser: BanreservasCdpBrowser<Frame>, acceptLogin: boolean): BanreservasCdpPage<Frame> | undefined {
  const pages = browser.contexts().flatMap((context) => context.pages());
  const pathOf = (page: BanreservasCdpPage<Frame>) => banreservasEmpresasTrustedPath(page.url());
  return pages.find((page) => pathOf(page) === banreservasEmpresasFramesetPath)
    ?? (acceptLogin ? pages.find((page) => pathOf(page) === banreservasEmpresasLoginPath) : undefined);
}

/** Observes the operator-owned isolated browser through frames; never opens, navigates, or closes pages. */
export function createBanreservasEmpresasCdpSessionChecker(cdpUrl: string, connect: BanreservasCdpConnect = lazyConnect): ReadonlySessionChecker {
  return Object.freeze({
    async check() {
      const unavailable = { status: "browser_unavailable" as const, checkedAt: new Date().toISOString(), safeSummary: SAFE_SUMMARY_UNAVAILABLE };
      if (!validCdpEndpoint(cdpUrl)) return unavailable;
      let browser: BanreservasCdpBrowser | undefined;
      try {
        browser = await connect(cdpUrl);
        const page = findTrustedPortalPage(browser, true);
        return page ? await createBanreservasEmpresasReadonlySessionChecker({ page: new CdpBanreservasEmpresasFrames(page) }).check() : unavailable;
      } catch {
        return unavailable;
      } finally {
        if (browser) try { await browser.close(); } catch { /* CDP detach must not change the safe result. */ }
      }
    },
  });
}

export type BanreservasEmpresasCdpScraperOptions = Readonly<{
  cdpUrl?: string;
  connect?: BanreservasCdpConnect<BanreservasCdpMainFrame>;
  clock?: () => Date;
  lookbackDays?: number;
  page?: CdpBanreservasEmpresasPageDependencies;
}>;

function manualAction(): ScrapeCollectionResult {
  return { status: "needs_admin_action", movements: [], safeErrorSummary: SAFE_SUMMARY_MANUAL };
}

/** Attaches only to the already-open Banreservas Empresas frameset tab; it is not registered in any runtime. */
export function createBanreservasEmpresasCdpScraper(options: BanreservasEmpresasCdpScraperOptions = {}): IngestionScraper {
  const connect = options.connect ?? lazyConnect;
  return Object.freeze({
    async collect(): Promise<ScrapeCollectionResult> {
      if (!validCdpEndpoint(options.cdpUrl)) return manualAction();
      let browser: BanreservasCdpBrowser<BanreservasCdpMainFrame> | undefined;
      try {
        browser = await connect(options.cdpUrl);
        const page = findTrustedPortalPage(browser, false);
        if (!page) return manualAction();
        const result = await collectBanreservasEmpresasMovements(new CdpBanreservasEmpresasPage(page, options.page), { clock: options.clock, lookbackDays: options.lookbackDays });
        return result.status === "collected" ? result : manualAction();
      } catch {
        return manualAction();
      } finally {
        if (browser) try { await browser.close(); } catch { /* CDP detach must not change the safe result. */ }
      }
    },
  });
}
