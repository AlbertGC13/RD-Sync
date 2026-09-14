import { describe, expect, it, vi } from "vitest";

import {
  BANRESERVAS_EMPRESAS_CDP_URL,
  CdpBanreservasEmpresasFrames,
  CdpBanreservasEmpresasPage,
  createBanreservasEmpresasCdpScraper,
  createBanreservasEmpresasCdpSessionChecker,
  resolveBanreservasEmpresasCdpUrl,
  type BanreservasCdpBrowser,
  type BanreservasCdpFrame,
  type BanreservasCdpMainFrame,
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
  constructor(private readonly address: string, private readonly pageFrames: readonly BanreservasCdpFrame[]) {}
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

// ---------------------------------------------------------------------------
// Movement collection adapter and scraper factory
// ---------------------------------------------------------------------------

const accountsUrl = `${origin}/TuBancoEmpresas/Pages/Accounts/Accounts.aspx`;
const detailUrl = `${origin}/TuBancoEmpresas/Pages/Common/ProductStatus.aspx?k=v`;
const accountGrid = "#ctl00_MainHolder_AccountGrid_AccountASPxGridView";
const transactionGrid = "#ctl00_MainHolder_AccountTransactionGrid_ASPxGridViewTransactions";
const dateFrom = "#ctl00_MainHolder_period_dateTextBoxDateFrom";
const dateTo = "#ctl00_MainHolder_period_dateTextBoxDateTo";
const fakeRows = [["29/06/26", "TXN-EXAMPLE-001", "PAYMENT RECEIVED", "0.00", "1,250.00", "DOP 9,999.99"]];

class MainFrame implements BanreservasCdpMainFrame {
  readonly calls: string[] = [];
  address: string;
  constructor(address: string, private readonly script: { evaluate?: unknown[]; landOn?: string; reachDetail?: boolean } = {}) { this.address = address; }
  name() { return "mainFrame"; }
  url() { return this.address; }
  async evaluate<Result>(pageFunction: (arg?: never) => Result, arg?: unknown): Promise<Result> {
    void pageFunction;
    this.calls.push(`evaluate:${JSON.stringify(arg ?? null)}`);
    const next = this.script.evaluate?.shift();
    if (next instanceof Error) throw next;
    return next as Result;
  }
  async goto(url: string) { this.calls.push(`goto:${url}`); this.address = this.script.landOn ?? url; }
  async click(selector: string) { this.calls.push(`click:${selector}`); if ((this.script.reachDetail ?? true) && /_DXDataRow\d+ > td:first-child$/.test(selector)) this.address = detailUrl; }
  async press(selector: string, key: string) { this.calls.push(`press:${selector}:${key}`); }
  async type(selector: string, text: string) { this.calls.push(`type:${selector}:${text}`); }
  async waitForSelector(selector: string) { this.calls.push(`waitForSelector:${selector}`); }
}

function framesetTab(main: MainFrame, headerMarker: unknown = true): BanreservasCdpPage<BanreservasCdpMainFrame> {
  const frames = [new Frame("topFrame", `${origin}/TuBancoEmpresas/Header.aspx`, headerMarker), new Frame("leftFrame", `${origin}/TuBancoEmpresas/Menu.aspx`), main];
  return { url: () => framesetUrl, frames: () => frames as unknown as readonly BanreservasCdpMainFrame[] };
}

function adapter(main: MainFrame, tab = framesetTab(main)) {
  let tick = 0;
  return new CdpBanreservasEmpresasPage(tab, { sleep: async () => {}, now: () => (tick += 1000), settleTimeoutMs: 5000, navigationTimeoutMs: 5000 });
}

describe("CdpBanreservasEmpresasPage", () => {
  it("navigates only the main frame to the accounts route and reports where it landed", async () => {
    const main = new MainFrame(`${origin}/TuBancoEmpresas/Home.aspx`);
    await expect(adapter(main).openAccountsQuery()).resolves.toBe(true);
    expect(main.calls).toEqual([`goto:${accountsUrl}`, `waitForSelector:${accountGrid}`]);
    await expect(adapter(new MainFrame(accountsUrl, { landOn: loginUrl })).openAccountsQuery()).resolves.toBe(false);
  });

  it("selects an account by clicking its indexed row and waits for the detail route", async () => {
    const main = new MainFrame(accountsUrl);
    await expect(adapter(main).selectAccountRow(1)).resolves.toBe(true);
    expect(main.calls).toEqual([`click:${accountGrid}_DXDataRow1 > td:first-child`, `waitForSelector:${transactionGrid}`]);
    await expect(adapter(new MainFrame(accountsUrl, { reachDetail: false })).selectAccountRow(0)).resolves.toBe(false);
  });

  it("types digit-only period bounds into both masked inputs and verifies the echoed values", async () => {
    const period = { from: "14/08/2026", to: "13/09/2026" };
    const main = new MainFrame(detailUrl, { evaluate: [["14/08/2026", "13/09/2026"]] });
    await expect(adapter(main).setPeriod(period)).resolves.toBe(true);
    expect(main.calls).toEqual([
      `click:${dateFrom}`, `press:${dateFrom}:Control+a`, `type:${dateFrom}:14082026`, `press:${dateFrom}:Tab`,
      `click:${dateTo}`, `press:${dateTo}:Control+a`, `type:${dateTo}:13092026`, `press:${dateTo}:Tab`,
      `evaluate:${JSON.stringify([dateFrom, dateTo])}`,
    ]);
    await expect(adapter(new MainFrame(detailUrl, { evaluate: [["14/08/2026", "12/09/2026"]] })).setPeriod(period)).resolves.toBe(false);
  });

  it("clicks Consultar or Next and waits until the async postback settles, failing on timeout", async () => {
    const main = new MainFrame(detailUrl, { evaluate: [true, true, false] });
    await expect(adapter(main).runQuery()).resolves.toBe(true);
    expect(main.calls[0]).toBe("click:#ctl00_MainHolder_period_linkButtonConsultar");
    expect(main.calls.filter((call) => call.startsWith("evaluate"))).toHaveLength(3);
    const stuck = new MainFrame(detailUrl, { evaluate: Array.from({ length: 20 }, () => true) });
    await expect(adapter(stuck).goToNextPage()).resolves.toBe(false);
    expect(stuck.calls[0]).toBe("click:#ctl00_MainHolder_AccountTransactionGrid_lnkNext");
  });

  it("reads grid state through the profile selectors and maps the session checker to access states", async () => {
    const main = new MainFrame(detailUrl, { evaluate: [2, "TYPE_1", fakeRows, false] });
    const page = adapter(main);
    await expect(page.countAccountRows()).resolves.toBe(2);
    await expect(page.selectedAccountKey()).resolves.toBe("TYPE_1");
    await expect(page.readVisibleTransactionRows()).resolves.toEqual(fakeRows);
    await expect(page.hasNextPage()).resolves.toBe(false);
    expect(main.calls).toEqual([
      `evaluate:${JSON.stringify(`${accountGrid} tr[id*="_AccountASPxGridView_DXDataRow"].dxgvDataRow`)}`,
      `evaluate:${JSON.stringify("#ctl00_MainHolder_cmbProducts")}`,
      `evaluate:${JSON.stringify(`${transactionGrid} tr[id*="_DXDataRow"].dxgvDataRow`)}`,
      `evaluate:${JSON.stringify("#ctl00_MainHolder_AccountTransactionGrid_lnkNext")}`,
    ]);
    await expect(adapter(new MainFrame(detailUrl)).accessState()).resolves.toBe("authenticated");
    await expect(adapter(new MainFrame(detailUrl), framesetTab(new MainFrame(detailUrl), false)).accessState()).resolves.toBe("unknown");
    const loginTab: BanreservasCdpPage<BanreservasCdpMainFrame> = { url: () => loginUrl, frames: () => [new Frame("", loginUrl, true)] as unknown as readonly BanreservasCdpMainFrame[] };
    await expect(new CdpBanreservasEmpresasPage(loginTab).accessState()).resolves.toBe("login");
  });
});

describe("createBanreservasEmpresasCdpScraper", () => {
  const clock = () => new Date("2026-09-13T15:00:00.000Z");
  const browserOf = (...pages: readonly BanreservasCdpPage<BanreservasCdpMainFrame>[]) => ({ close: vi.fn(async () => {}), contexts: () => [{ pages: () => pages }] });
  const scraper = (browser: ReturnType<typeof browserOf>, cdpUrl = BANRESERVAS_EMPRESAS_CDP_URL) => {
    const connect = vi.fn(async () => browser);
    return { connect, scraper: createBanreservasEmpresasCdpScraper({ cdpUrl, connect, clock, page: { sleep: async () => {} } }) };
  };

  it("collects one account through the consultation flow only, then detaches without closing the page", async () => {
    const main = new MainFrame(`${origin}/TuBancoEmpresas/Home.aspx`, { evaluate: [1, "TYPE_1", ["14/08/2026", "13/09/2026"], false, fakeRows, false] });
    const tab = framesetTab(main);
    const browser = browserOf(tab);
    const result = await scraper(browser).scraper.collect();
    expect(result).toMatchObject({ status: "collected", movements: [expect.objectContaining({ bankId: "banreservas_empresas", direction: "credit", amount: "1250.00" })] });
    expect(result.movements[0].accountFingerprint).toMatch(/^banreservas_empresas-[0-9a-f]{10}$/);
    const clicked = main.calls.filter((call) => call.startsWith("click:")).map((call) => call.slice(6));
    expect(clicked).toEqual([`${accountGrid}_DXDataRow0 > td:first-child`, dateFrom, dateTo, "#ctl00_MainHolder_period_linkButtonConsultar"]);
    expect(clicked.some((selector) => /linkButtonGeneratePDF|linkButtonQIF|linkButtonCSV|linkButton2|Transfer|Payment|Logout/i.test(selector))).toBe(false);
    expect(browser.close).toHaveBeenCalledOnce();
    expect("close" in tab).toBe(false);
  });

  it("maps invalid endpoints, missing framesets, connection errors, and collection failures to one safe manual result", async () => {
    const manual = { status: "needs_admin_action", movements: [], safeErrorSummary: "Banreservas Empresas observation requires administrator action." };
    const { connect, scraper: invalid } = scraper(browserOf(), "http://example.test:9225");
    await expect(invalid.collect()).resolves.toEqual(manual);
    expect(connect).not.toHaveBeenCalled();
    const loginOnly: BanreservasCdpPage<BanreservasCdpMainFrame> = { url: () => loginUrl, frames: () => [new Frame("", loginUrl, true)] as unknown as readonly BanreservasCdpMainFrame[] };
    const broken = framesetTab(new MainFrame(`${origin}/TuBancoEmpresas/Home.aspx`, { landOn: loginUrl }));
    for (const candidate of [
      scraper(browserOf()).scraper,
      scraper(browserOf(loginOnly)).scraper,
      scraper(browserOf(broken)).scraper,
      createBanreservasEmpresasCdpScraper({ cdpUrl: BANRESERVAS_EMPRESAS_CDP_URL, connect: async () => { throw new Error("internal"); } }),
    ]) {
      const result = await candidate.collect();
      expect(result).toEqual(manual);
      expect("cause" in result).toBe(false);
    }
  });
});
