import type { ReadonlySessionChecker } from "./authenticated-session-probe";

const BANRESERVAS_EMPRESAS_ORIGIN = "https://www.banreservas.com.do";
const PORTAL_PREFIX = "/TuBancoEmpresas/";
const FRAMESET_PATH = "/TuBancoEmpresas/Default.aspx";
const LOGIN_PATH = "/TuBancoEmpresas/Login.aspx";
const HEADER_PATH = "/TuBancoEmpresas/Header.aspx";
const MENU_PATH = "/TuBancoEmpresas/Menu.aspx";
const SAFE_SUMMARY_UNAVAILABLE = "Banreservas Empresas session is unavailable.";

export type BanreservasEmpresasFrameName = "topFrame" | "leftFrame" | "mainFrame";

/**
 * Read-only WebForms frameset seam. Implementations expose only frame routes
 * and boolean evidence, so header text, menus, and account content never escape.
 */
export interface BanreservasEmpresasFrameObservation {
  currentUrl(): Promise<string>;
  frameUrl(name: BanreservasEmpresasFrameName): Promise<string | undefined>;
  /** True when the header frame renders the portal's logout link. */
  hasAuthenticatedHeaderMarker(): Promise<boolean>;
  /** True when a document on the trusted login route renders a password field. */
  hasLoginPageEvidence(): Promise<boolean>;
}

export type BanreservasEmpresasSessionCheckerDependencies = Readonly<{
  page: BanreservasEmpresasFrameObservation;
  clock?: () => Date;
}>;

type CheckResult = Readonly<{
  status: "active" | "expired" | "browser_unavailable";
  checkedAt: string;
  safeSummary: string;
}>;

/** Returns the pathname only for the exact https portal origin without embedded credentials. */
export function banreservasEmpresasTrustedPath(value: string | undefined): string | undefined {
  try {
    const url = new URL(value ?? "");
    return url.protocol === "https:" && url.origin === BANRESERVAS_EMPRESAS_ORIGIN && !url.username && !url.password
      ? url.pathname
      : undefined;
  } catch {
    return undefined;
  }
}

export const banreservasEmpresasLoginPath = LOGIN_PATH;
export const banreservasEmpresasFramesetPath = FRAMESET_PATH;

function result(status: CheckResult["status"], clock: () => Date, safeSummary: string): CheckResult {
  return { status, checkedAt: clock().toISOString(), safeSummary };
}

function isPortalMainFrame(path: string | undefined): boolean {
  return path !== undefined && path.startsWith(PORTAL_PREFIX) && path !== LOGIN_PATH;
}

/** Classifies only proven Banreservas Empresas frameset states; every other observation fails closed. */
export function createBanreservasEmpresasReadonlySessionChecker(
  { page, clock = () => new Date() }: BanreservasEmpresasSessionCheckerDependencies,
): ReadonlySessionChecker {
  const unavailable = () => result("browser_unavailable", clock, SAFE_SUMMARY_UNAVAILABLE);
  const expiredIfProven = async () => (await page.hasLoginPageEvidence())
    ? result("expired", clock, "Banreservas Empresas sign-in is required.")
    : unavailable();
  return Object.freeze({
    async check(): Promise<CheckResult> {
      try {
        const topPath = banreservasEmpresasTrustedPath(await page.currentUrl());
        if (topPath === LOGIN_PATH) return await expiredIfProven();
        if (topPath !== FRAMESET_PATH) return unavailable();
        const [header, menu, main] = await Promise.all([page.frameUrl("topFrame"), page.frameUrl("leftFrame"), page.frameUrl("mainFrame")]);
        if (banreservasEmpresasTrustedPath(header) !== HEADER_PATH || banreservasEmpresasTrustedPath(menu) !== MENU_PATH) return unavailable();
        const mainPath = banreservasEmpresasTrustedPath(main);
        if (mainPath === LOGIN_PATH) return await expiredIfProven();
        if (!isPortalMainFrame(mainPath)) return unavailable();
        return (await page.hasAuthenticatedHeaderMarker())
          ? result("active", clock, "Banreservas Empresas session is active.")
          : unavailable();
      } catch {
        return unavailable();
      }
    },
  });
}
