import { describe, expect, it, vi } from "vitest";

import {
  BANRESERVAS_EMPRESAS_CDP_URL,
  CdpBanreservasEmpresasFrames,
  createBanreservasEmpresasCdpSessionChecker,
  resolveBanreservasEmpresasCdpUrl,
  type BanreservasCdpBrowser,
  type BanreservasCdpFrame,
  type BanreservasCdpPage,
} from "./banreservas-empresas-cdp";

const origin = "https://www.banreservas.com.do";
const framesetUrl = `${origin}/TuBancoEmpresas/Default.aspx`;
const loginUrl = `${origin}/TuBancoEmpresas/Login.aspx`;

class Frame implements BanreservasCdpFrame {
  readonly evaluations = vi.fn();
  constructor(private readonly frameName: string, private readonly address: string, private readonly value: unknown = false) {}
  name() { return this.frameName; }
  url() { return this.address; }
  async evaluate<Result>(_pageFunction: () => Result): Promise<Result> {
    void _pageFunction;
    this.evaluations();
    if (this.value instanceof Error) throw this.value;
    return this.value as Result;
  }
}

class Page implements BanreservasCdpPage {
  constructor(private readonly address: string, private readonly pageFrames: readonly Frame[]) {}
  url() { return this.address; }
  frames() { return this.pageFrames; }
}

class Browser implements BanreservasCdpBrowser {
  readonly close = vi.fn(async () => {});
  constructor(private readonly openPages: readonly Page[]) {}
  contexts() { return [{ pages: () => this.openPages }]; }
}

function authenticatedTab(mainFrameUrl = `${origin}/TuBancoEmpresas/Home.aspx`, headerMarker: unknown = true) {
  const top = new Frame("topFrame", `${origin}/TuBancoEmpresas/Header.aspx`, headerMarker);
  const left = new Frame("leftFrame", `${origin}/TuBancoEmpresas/Menu.aspx`, new Error("menu must not be evaluated"));
  const main = new Frame("mainFrame", mainFrameUrl, new Error("main frame must not be evaluated for the marker"));
  return { page: new Page(framesetUrl, [new Frame("", framesetUrl, new Error("top document must not be evaluated")), top, left, main]), top, left, main };
}

describe("resolveBanreservasEmpresasCdpUrl", () => {
  it("uses the explicit isolated endpoint and never the Popular or global CDP endpoints", () => {
    expect(BANRESERVAS_EMPRESAS_CDP_URL).toBe("http://127.0.0.1:9225");
    expect(resolveBanreservasEmpresasCdpUrl({})).toBe("http://127.0.0.1:9225");
    expect(resolveBanreservasEmpresasCdpUrl({ RD_SYNC_CDP_URL: "http://127.0.0.1:9222", RD_SYNC_BANK_POPULAR_CDP_URL: "http://127.0.0.1:9223", RD_SYNC_BANK_BANRESERVAS_EMPRESAS_CDP_URL: "   " })).toBe("http://127.0.0.1:9225");
    expect(resolveBanreservasEmpresasCdpUrl({ RD_SYNC_BANK_BANRESERVAS_EMPRESAS_CDP_URL: "http://localhost:9325" })).toBe("http://localhost:9325");
  });

  it("fails closed instead of falling back when the explicit endpoint is malformed", () => {
    for (const endpoint of ["http://example.test:9225", "http://user:pass@127.0.0.1:9225", "https://127.0.0.1:9225", "http://127.0.0.1:0", "http://127.0.0.1:65536", "http://127.0.0.1:09225", "http://127.0.0.1:9225/", " http://127.0.0.1:9225"]) {
      expect(resolveBanreservasEmpresasCdpUrl({ RD_SYNC_BANK_BANRESERVAS_EMPRESAS_CDP_URL: endpoint, RD_SYNC_CDP_URL: "http://127.0.0.1:9222" })).toBeUndefined();
    }
  });
});

describe("CdpBanreservasEmpresasFrames", () => {
  it("exposes sanitized frame URLs and evaluates the logout marker only inside the header frame", async () => {
    const { page, top, left, main } = authenticatedTab();
    const frames = new CdpBanreservasEmpresasFrames(page);
    await expect(frames.currentUrl()).resolves.toBe(framesetUrl);
    await expect(frames.frameUrl("leftFrame")).resolves.toBe(`${origin}/TuBancoEmpresas/Menu.aspx`);
    await expect(new CdpBanreservasEmpresasFrames(new Page(framesetUrl, [])).frameUrl("mainFrame")).resolves.toBeUndefined();
    await expect(frames.hasAuthenticatedHeaderMarker()).resolves.toBe(true);
    expect(top.evaluations).toHaveBeenCalledOnce();
    expect(left.evaluations).not.toHaveBeenCalled();
    expect(main.evaluations).not.toHaveBeenCalled();
    await expect(new CdpBanreservasEmpresasFrames(new Page(framesetUrl, [])).hasAuthenticatedHeaderMarker()).resolves.toBe(false);
  });

  it("looks for login-page evidence only in frames that sit on the trusted login route", async () => {
    const loginFrame = new Frame("", loginUrl, true);
    const foreign = new Frame("", "https://evil.test/TuBancoEmpresas/Login.aspx", true);
    const home = new Frame("mainFrame", `${origin}/TuBancoEmpresas/Home.aspx`, true);
    await expect(new CdpBanreservasEmpresasFrames(new Page(loginUrl, [foreign, home])).hasLoginPageEvidence()).resolves.toBe(false);
    expect(foreign.evaluations).not.toHaveBeenCalled();
    expect(home.evaluations).not.toHaveBeenCalled();
    await expect(new CdpBanreservasEmpresasFrames(new Page(loginUrl, [loginFrame])).hasLoginPageEvidence()).resolves.toBe(true);
  });
});

describe("createBanreservasEmpresasCdpSessionChecker", () => {
  const checker = (browser: Browser, cdpUrl = BANRESERVAS_EMPRESAS_CDP_URL) => {
    const connect = vi.fn(async () => browser);
    return { connect, checker: createBanreservasEmpresasCdpSessionChecker(cdpUrl, connect) };
  };

  it("observes the existing frameset tab, reports active, and detaches without closing the operator page", async () => {
    const { page } = authenticatedTab(`${origin}/TuBancoEmpresas/Pages/Common/ProductStatus.aspx?k=v`);
    const browser = new Browser([new Page("about:blank", []), page]);
    await expect(checker(browser).checker.check()).resolves.toMatchObject({ status: "active" });
    expect(browser.close).toHaveBeenCalledOnce();
    expect("close" in page).toBe(false);
    expect("goto" in page).toBe(false);
    expect("newPage" in browser).toBe(false);
  });

  it("prefers the frameset tab over a stale login tab and reports expiration only from the login tab", async () => {
    const loginPage = new Page(loginUrl, [new Frame("", loginUrl, true)]);
    const { page } = authenticatedTab();
    await expect(checker(new Browser([loginPage, page])).checker.check()).resolves.toMatchObject({ status: "active" });
    await expect(checker(new Browser([loginPage])).checker.check()).resolves.toMatchObject({ status: "expired" });
  });

  it("rejects invalid endpoints before connecting and maps every failure to one safe unavailable result", async () => {
    const unavailable = { status: "browser_unavailable", safeSummary: "Banreservas Empresas session is unavailable." };
    for (const endpoint of ["http://127.0.0.1:9222/path", "http://example.test:9225", "http://user:pass@127.0.0.1:9225", ""]) {
      const { connect, checker: candidate } = checker(new Browser([]), endpoint);
      await expect(candidate.check()).resolves.toMatchObject(unavailable);
      expect(connect).not.toHaveBeenCalled();
    }
    const { page: broken } = authenticatedTab(`${origin}/TuBancoEmpresas/Home.aspx`, new Error("internal"));
    for (const candidate of [
      checker(new Browser([])).checker,
      checker(new Browser([new Page("https://evil.test/TuBancoEmpresas/Default.aspx", [])])).checker,
      checker(new Browser([broken])).checker,
      createBanreservasEmpresasCdpSessionChecker(BANRESERVAS_EMPRESAS_CDP_URL, async () => { throw new Error("internal"); }),
    ]) {
      const result = await candidate.check();
      expect(result).toMatchObject(unavailable);
      expect(Object.keys(result as object).sort()).toEqual(["checkedAt", "safeSummary", "status"]);
    }
  });

  it("ignores CDP detach failure without changing the safe result", async () => {
    const { page } = authenticatedTab();
    const browser = new Browser([page]);
    browser.close.mockRejectedValueOnce(new Error("internal"));
    await expect(checker(browser).checker.check()).resolves.toMatchObject({ status: "active" });
    expect(browser.close).toHaveBeenCalledOnce();
  });
});
