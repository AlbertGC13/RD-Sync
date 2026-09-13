import type { ReadonlySessionChecker } from "../authenticated-session-probe";
import {
  banreservasEmpresasFramesetPath,
  banreservasEmpresasLoginPath,
  banreservasEmpresasTrustedPath,
  createBanreservasEmpresasReadonlySessionChecker,
  type BanreservasEmpresasFrameName,
  type BanreservasEmpresasFrameObservation,
} from "../banreservas-empresas-session-checker";

/** Canonical isolated loopback endpoint launched by scripts/launch-bank-browser for this portal. */
export const BANRESERVAS_EMPRESAS_CDP_URL = "http://127.0.0.1:9225";
export const BANRESERVAS_EMPRESAS_CDP_URL_ENV = "RD_SYNC_BANK_BANRESERVAS_EMPRESAS_CDP_URL";
const LOOPBACK_CDP = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):([1-9]\d{0,4})$/;
const SAFE_SUMMARY_UNAVAILABLE = "Banreservas Empresas session is unavailable.";

export interface BanreservasCdpFrame {
  name(): string;
  url(): string;
  evaluate<Result>(pageFunction: () => Result): Promise<Result>;
}

export interface BanreservasCdpPage {
  url(): string;
  frames(): readonly BanreservasCdpFrame[];
}

export interface BanreservasCdpBrowser {
  contexts(): readonly { pages(): readonly BanreservasCdpPage[] }[];
  close(): Promise<void>;
}

export type BanreservasCdpConnect = (cdpUrl: string) => Promise<BanreservasCdpBrowser>;

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

async function lazyConnect(cdpUrl: string): Promise<BanreservasCdpBrowser> {
  const { chromium } = await import("playwright-core");
  return chromium.connectOverCDP(cdpUrl) as unknown as BanreservasCdpBrowser;
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

function findTrustedPortalPage(browser: BanreservasCdpBrowser): BanreservasCdpPage | undefined {
  const pages = browser.contexts().flatMap((context) => context.pages());
  const pathOf = (page: BanreservasCdpPage) => banreservasEmpresasTrustedPath(page.url());
  return pages.find((page) => pathOf(page) === banreservasEmpresasFramesetPath)
    ?? pages.find((page) => pathOf(page) === banreservasEmpresasLoginPath);
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
        const page = findTrustedPortalPage(browser);
        return page ? await createBanreservasEmpresasReadonlySessionChecker({ page: new CdpBanreservasEmpresasFrames(page) }).check() : unavailable;
      } catch {
        return unavailable;
      } finally {
        if (browser) try { await browser.close(); } catch { /* CDP detach must not change the safe result. */ }
      }
    },
  });
}
