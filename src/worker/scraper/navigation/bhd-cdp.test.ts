import { describe, expect, it, vi } from "vitest";

import { CdpBhdPersonalPage, createBhdPersonalCdpScraper, createBhdPersonalCdpSessionChecker, type BhdCdpBrowser, type BhdCdpPage } from "./bhd-cdp";
import { createBhdPersonalReadonlySessionChecker } from "../bhd-personal-session-checker";

const productUrl = "https://ibp.bhd.com.do/#/bhd/product-detail";
const rows = [["27/06/2026", "1", "DEBIT", "R1", "RD$ 5.00", "", "RD$ 10.00"], ["27/06/2026", "2", "CREDIT", "R2", "", "RD$ 9.00", "RD$ 19.00"]];

class Page implements BhdCdpPage {
  readonly evaluations = vi.fn();
  constructor(private readonly address: string, private readonly values: unknown[] = ["authenticated", true, rows, false]) {}
  url() { return this.address; }
  async evaluate<Result>(_pageFunction: () => Result): Promise<Result> {
    void _pageFunction;
    this.evaluations();
    return this.values.shift() as Result;
  }
}

class Browser implements BhdCdpBrowser {
  readonly close = vi.fn(async () => {});
  constructor(private readonly openPages: readonly Page[]) {}
  contexts() { return [{ pages: () => this.openPages }]; }
}

function scraper(browser: Browser, cdpUrl = "http://127.0.0.1:9444") {
  const connect = vi.fn(async () => browser);
  return { connect, scraper: createBhdPersonalCdpScraper({ cdpUrl, connect }) };
}

describe("createBhdPersonalCdpScraper", () => {
  it("normalizes debit and credit rows from the exact existing BHD Personal product tab", async () => {
    const page = new Page(productUrl, ["authenticated", true, rows, false]);
    const browser = new Browser([page]);

    const result = await scraper(browser).scraper.collect();
    expect(result).toMatchObject({
      status: "collected", movements: [
        expect.objectContaining({ bankId: "bhd_personal", direction: "debit", amount: "5.00" }),
        expect.objectContaining({ bankId: "bhd_personal", direction: "credit", amount: "9.00" }),
      ],
    });
    expect(result.movements[0]).not.toHaveProperty("balance");
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it("never creates, navigates, or closes the operator-owned page", async () => {
    const page = new Page(productUrl, ["authenticated", true, [], false]);
    const browser = new Browser([page]);

    await scraper(browser).scraper.collect();
    expect("newPage" in browser).toBe(false);
    expect("goto" in page).toBe(false);
    expect("close" in page).toBe(false);
  });

  it("rejects malformed, credentialed, non-loopback, zero, oversized, and leading-zero endpoints before connecting", async () => {
    const missingConnect = vi.fn(async () => new Browser([]));
    await expect(createBhdPersonalCdpScraper({ connect: missingConnect }).collect()).resolves.toMatchObject({ status: "needs_admin_action", movements: [] });
    expect(missingConnect).not.toHaveBeenCalled();
    for (const endpoint of ["http://user:pass@127.0.0.1:9444", "http://example.test:9444", "http://127.0.0.1:0", "http://127.0.0.1:65536", "http://127.0.0.1:09444", "http://127.0.0.1:9444/path", "http://127.0.0.1:9444?x=1", "http://127.0.0.1:9444#x"]) {
      const { connect, scraper: candidate } = scraper(new Browser([]), endpoint);
      await expect(candidate.collect()).resolves.toEqual({ status: "needs_admin_action", movements: [], safeErrorSummary: "BHD Personal observation requires administrator action." });
      expect(connect).not.toHaveBeenCalled();
    }
  });

  it("rejects foreign, alias, and non-product tabs without DOM observation", async () => {
    for (const url of ["https://evil.test/#/bhd/product-detail", "https://bhd.com.do/#/bhd/product-detail", "https://ibp.bhd.com.do/#/bhd/dashboard", "https://ibp.bhd.com.do/other#/bhd/product-detail"]) {
      const page = new Page(url);
      await expect(scraper(new Browser([page])).scraper.collect()).resolves.toMatchObject({ status: "needs_admin_action", movements: [] });
      expect(page.evaluations).not.toHaveBeenCalled();
    }
  });

  it("maps protected, unknown, malformed, connection, and no-tab failures to one safe manual result without a session cause", async () => {
    const broken = new Page(productUrl);
    vi.spyOn(broken, "evaluate").mockRejectedValueOnce(new Error("internal"));
    const scenarios = [
      () => scraper(new Browser([new Page(productUrl, ["login"])]), "http://127.0.0.1:9444").scraper,
      () => scraper(new Browser([new Page(productUrl, ["protected"])]), "http://127.0.0.1:9444").scraper,
      () => scraper(new Browser([new Page(productUrl, ["unknown"])]), "http://127.0.0.1:9444").scraper,
      () => scraper(new Browser([new Page(productUrl, ["authenticated", true, [["bad"]]])]), "http://127.0.0.1:9444").scraper,
      () => createBhdPersonalCdpScraper({ cdpUrl: "http://127.0.0.1:9444", connect: async () => { throw new Error("internal"); } }),
      () => scraper(new Browser([broken])).scraper,
      () => scraper(new Browser([])).scraper,
    ];
    for (const candidate of scenarios) {
      const result = await candidate().collect();
      expect(result).toEqual({ status: "needs_admin_action", movements: [], safeErrorSummary: "BHD Personal observation requires administrator action." });
      expect("cause" in result).toBe(false);
    }
  });

  it("ignores CDP disconnect failure without closing the page", async () => {
    const page = new Page(productUrl, ["authenticated", true, [], false]);
    const browser = new Browser([page]);
    browser.close.mockRejectedValueOnce(new Error("internal"));

    await expect(scraper(browser).scraper.collect()).resolves.toMatchObject({ status: "collected", movements: [] });
    expect(browser.close).toHaveBeenCalledOnce();
    expect("close" in page).toBe(false);
  });

  it("uses the same adapter for read-only session observation", async () => {
    const page = new Page(productUrl, [true]);
    const checker = createBhdPersonalReadonlySessionChecker({ page: new CdpBhdPersonalPage(page), clock: () => new Date("2026-08-25T00:00:00.000Z") });

    await expect(checker.check()).resolves.toMatchObject({ status: "active" });
    expect(page.evaluations).toHaveBeenCalledOnce();
    expect("goto" in page).toBe(false);
    expect("close" in page).toBe(false);
  });

  it("detaches after session observation without closing the trusted page", async () => {
    const page = new Page(productUrl, [true]);
    const browser = new Browser([page]);

    await expect(createBhdPersonalCdpSessionChecker("http://127.0.0.1:9444", async () => browser).check()).resolves.toMatchObject({ status: "active" });
    expect(browser.close).toHaveBeenCalledOnce();
    expect("close" in page).toBe(false);
  });
});
