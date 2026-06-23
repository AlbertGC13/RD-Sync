import { describe, expect, it } from "vitest";

import {
  createPopularCdpScraper,
  extractResultsTableFromDocument,
  type CdpBrowserLike,
  type CdpContextLike,
  type CdpPageLike,
  type DocumentLike,
  type ElementLike,
} from "./popular-cdp";
import type { PopularTransactionRow } from "../../../modules/bank-adapters/popular";

// ---------------------------------------------------------------------------
// Synthetic fixture rows (same values as the brief fixture)
// ---------------------------------------------------------------------------

const FIXTURE_ROWS: PopularTransactionRow[] = [
  {
    postedDate: "01/01/2025",
    effectiveDate: "01/01/2025",
    checkNumber: "0001000000001",
    referenceNumber: "",
    description: "PAGO FICTICIO 001 EJEMPLO",
    amount: "$-1,234.56",
    imageAvailable: false,
    detailAvailable: true,
  },
  {
    postedDate: "02/01/2025",
    effectiveDate: "02/01/2025",
    checkNumber: "",
    referenceNumber: "",
    description: "DEPOSITO FICTICIO 002 EJEMPLO",
    amount: "$4,000.00",
    imageAvailable: false,
    detailAvailable: true,
  },
];

// ---------------------------------------------------------------------------
// Fake CDP surfaces
// ---------------------------------------------------------------------------

function makeFakeCdpPage(overrides: Partial<FakeCdpPageState> = {}): FakeCdpPage {
  return new FakeCdpPage({
    url: "https://ib.bpd.com.do/accountdetails/transactions",
    ...overrides,
  });
}

interface FakeCdpPageState {
  url: string;
  evaluateResult?: unknown;
  gotoError?: Error;
}

class FakeCdpPage implements CdpPageLike {
  readonly gotoUrls: string[] = [];
  readonly waitForTimeoutCalls: number[] = [];
  readonly evaluateCalls: Array<{ fn: (arg?: unknown) => unknown; arg: unknown }> = [];
  closed = false;

  constructor(private readonly state: FakeCdpPageState) {}

  url(): string {
    return this.state.url;
  }

  async goto(url: string, options?: unknown): Promise<unknown> {
    void options;
    if (this.state.gotoError) throw this.state.gotoError;
    this.gotoUrls.push(url);
    return {};
  }

  async waitForSelector(selector: string, opts?: unknown): Promise<unknown> {
    void selector;
    void opts;
    return {};
  }

  async waitForTimeout(ms: number): Promise<void> {
    this.waitForTimeoutCalls.push(ms);
  }

  async evaluate<T>(fn: (arg?: unknown) => T, arg?: unknown): Promise<T> {
    this.evaluateCalls.push({ fn: fn as (arg?: unknown) => unknown, arg });
    return (this.state.evaluateResult ?? null) as T;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class FakeCdpContext implements CdpContextLike {
  readonly createdPages: FakeCdpPage[] = [];

  constructor(private readonly pageFactory: () => FakeCdpPage) {}

  async newPage(): Promise<CdpPageLike> {
    const page = this.pageFactory();
    this.createdPages.push(page);
    return page;
  }
}

class FakeCdpBrowser implements CdpBrowserLike {
  readonly createdPages: FakeCdpPage[] = [];
  readonly defaultContext: FakeCdpContext;
  browserNewPageCalls = 0;
  closed = false;
  private readonly hasDefaultContext: boolean;

  constructor(pageFactory: () => FakeCdpPage, options: { hasDefaultContext?: boolean } = {}) {
    this.hasDefaultContext = options.hasDefaultContext ?? true;
    this.defaultContext = new FakeCdpContext(() => {
      const page = pageFactory();
      this.createdPages.push(page);
      return page;
    });
  }

  contexts(): CdpContextLike[] {
    return this.hasDefaultContext ? [this.defaultContext] : [];
  }

  async newPage(): Promise<CdpPageLike> {
    this.browserNewPageCalls += 1;
    const page = this.defaultContext.newPage();
    return page;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

// ---------------------------------------------------------------------------
// createPopularCdpScraper — happy path
// ---------------------------------------------------------------------------

describe("createPopularCdpScraper — happy path", () => {
  it("returns status collected with movements parsed from the portal rows", async () => {
    const browser = new FakeCdpBrowser(() => makeFakeCdpPage());
    const scraper = createPopularCdpScraper({
      cdpUrl: "http://127.0.0.1:9222",
      clock: () => new Date("2025-01-01T04:00:00Z"),
      connect: async (cdpEndpoint: string) => { void cdpEndpoint; return browser; },
      collectRows: async () => ({ kind: "rows" as const, rows: FIXTURE_ROWS }),
    });

    const result = await scraper.collect();

    expect(result.status).toBe("collected");
    expect(result.movements).toHaveLength(2);
    expect(result.movements[0].bankId).toBe("popular");
    expect(result.movements[0].direction).toBe("debit");
    expect(result.movements[1].direction).toBe("credit");
  });

  it("returns status needs_admin_action when collectRows returns needs_admin_action", async () => {
    const browser = new FakeCdpBrowser(() => makeFakeCdpPage());
    const scraper = createPopularCdpScraper({
      cdpUrl: "http://127.0.0.1:9222",
      clock: () => new Date("2025-01-01T04:00:00Z"),
      connect: async (cdpEndpoint: string) => { void cdpEndpoint; return browser; },
      collectRows: async () => ({
        kind: "needs_admin_action" as const,
        safeErrorSummary: "Bank session expired or requires verification",
      }),
    });

    const result = await scraper.collect();

    expect(result.status).toBe("needs_admin_action");
    expect(result.movements).toEqual([]);
    expect(result.safeErrorSummary).toBe("Bank session expired or requires verification");
  });
});

// ---------------------------------------------------------------------------
// createPopularCdpScraper — session context
// ---------------------------------------------------------------------------

describe("createPopularCdpScraper — session context", () => {
  it("creates the page from the browser's default context so it shares the logged-in session", async () => {
    // browser.newPage() on a connectOverCDP handle opens a NEW (incognito-like)
    // context without the human session's cookies — every real run would hit
    // the login redirect. The page must come from contexts()[0].
    const browser = new FakeCdpBrowser(() => makeFakeCdpPage());
    const scraper = createPopularCdpScraper({
      cdpUrl: "http://127.0.0.1:9222",
      clock: () => new Date("2025-01-01T04:00:00Z"),
      connect: async (cdpEndpoint: string) => { void cdpEndpoint; return browser; },
      collectRows: async () => ({ kind: "rows" as const, rows: FIXTURE_ROWS }),
    });

    await scraper.collect();

    expect(browser.defaultContext.createdPages).toHaveLength(1);
    expect(browser.browserNewPageCalls).toBe(0);
  });

  it("falls back to browser.newPage() when no default context is exposed", async () => {
    const browser = new FakeCdpBrowser(() => makeFakeCdpPage(), { hasDefaultContext: false });
    const scraper = createPopularCdpScraper({
      cdpUrl: "http://127.0.0.1:9222",
      clock: () => new Date("2025-01-01T04:00:00Z"),
      connect: async (cdpEndpoint: string) => { void cdpEndpoint; return browser; },
      collectRows: async () => ({ kind: "rows" as const, rows: FIXTURE_ROWS }),
    });

    const result = await scraper.collect();

    expect(result.status).toBe("collected");
    expect(browser.browserNewPageCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// createPopularCdpScraper — connect failure
// ---------------------------------------------------------------------------

describe("createPopularCdpScraper — connect failure", () => {
  it("returns needs_admin_action (does not throw) when connect rejects", async () => {
    const scraper = createPopularCdpScraper({
      cdpUrl: "http://127.0.0.1:9222",
      clock: () => new Date("2025-01-01T04:00:00Z"),
      connect: async (cdpEndpoint: string) => {
        void cdpEndpoint;
        throw new Error("Connection refused");
      },
      collectRows: async () => ({ kind: "rows" as const, rows: [] }),
    });

    const result = await scraper.collect();

    expect(result.status).toBe("needs_admin_action");
    expect(result.movements).toEqual([]);
    expect(result.safeErrorSummary).toBe("Bank browser session is not available");
  });
});

// ---------------------------------------------------------------------------
// createPopularCdpScraper — ensureBrowser seam
// ---------------------------------------------------------------------------

describe("createPopularCdpScraper — ensureBrowser seam", () => {
  it("calls ensureBrowser before connect and proceeds when it succeeds", async () => {
    const callOrder: string[] = [];
    const browser = new FakeCdpBrowser(() => makeFakeCdpPage());
    const scraper = createPopularCdpScraper({
      cdpUrl: "http://127.0.0.1:9222",
      clock: () => new Date("2025-01-01T04:00:00Z"),
      ensureBrowser: async () => {
        callOrder.push("ensureBrowser");
        return { ok: true };
      },
      connect: async (cdpEndpoint: string) => {
        void cdpEndpoint;
        callOrder.push("connect");
        return browser;
      },
      collectRows: async () => ({ kind: "rows" as const, rows: FIXTURE_ROWS }),
    });

    const result = await scraper.collect();

    expect(result.status).toBe("collected");
    expect(callOrder).toEqual(["ensureBrowser", "connect"]);
  });

  it("returns needs_admin_action without connecting when ensureBrowser fails", async () => {
    let connectCalled = false;
    const scraper = createPopularCdpScraper({
      cdpUrl: "http://127.0.0.1:9222",
      clock: () => new Date("2025-01-01T04:00:00Z"),
      ensureBrowser: async () => ({
        ok: false,
        safeErrorSummary: "Bank browser is not running",
      }),
      connect: async (cdpEndpoint: string) => {
        void cdpEndpoint;
        connectCalled = true;
        throw new Error("should not be called");
      },
      collectRows: async () => ({ kind: "rows" as const, rows: FIXTURE_ROWS }),
    });

    const result = await scraper.collect();

    expect(result.status).toBe("needs_admin_action");
    expect(result.movements).toEqual([]);
    expect(result.safeErrorSummary).toBe("Bank browser is not running");
    expect(connectCalled).toBe(false);
  });

  it("does not call ensureBrowser when not provided (backward compatible)", async () => {
    const browser = new FakeCdpBrowser(() => makeFakeCdpPage());
    const scraper = createPopularCdpScraper({
      cdpUrl: "http://127.0.0.1:9222",
      clock: () => new Date("2025-01-01T04:00:00Z"),
      connect: async (cdpEndpoint: string) => { void cdpEndpoint; return browser; },
      collectRows: async () => ({ kind: "rows" as const, rows: FIXTURE_ROWS }),
    });

    const result = await scraper.collect();

    // No ensureBrowser → behaves exactly as before
    expect(result.status).toBe("collected");
  });
});

// ---------------------------------------------------------------------------
// createPopularCdpScraper — resource cleanup
// ---------------------------------------------------------------------------

describe("createPopularCdpScraper — resource cleanup", () => {
  it("closes the page and the browser handle in finally even after a successful collect", async () => {
    const pageSlot: { ref: FakeCdpPage | null } = { ref: null };
    const browser = new FakeCdpBrowser(() => {
      const page = makeFakeCdpPage();
      pageSlot.ref = page;
      return page;
    });

    const scraper = createPopularCdpScraper({
      cdpUrl: "http://127.0.0.1:9222",
      clock: () => new Date("2025-01-01T04:00:00Z"),
      connect: async (cdpEndpoint: string) => { void cdpEndpoint; return browser; },
      collectRows: async () => ({ kind: "rows" as const, rows: FIXTURE_ROWS }),
    });

    await scraper.collect();

    expect(pageSlot.ref?.closed).toBe(true);
    expect(browser.closed).toBe(true);
  });

  it("closes page and browser even when collectRows throws", async () => {
    const pageSlot: { ref: FakeCdpPage | null } = { ref: null };
    const browser = new FakeCdpBrowser(() => {
      const page = makeFakeCdpPage();
      pageSlot.ref = page;
      return page;
    });

    const scraper = createPopularCdpScraper({
      cdpUrl: "http://127.0.0.1:9222",
      clock: () => new Date("2025-01-01T04:00:00Z"),
      connect: async (cdpEndpoint: string) => { void cdpEndpoint; return browser; },
      collectRows: async () => {
        throw new Error("DOM extraction failed unexpectedly");
      },
    });

    await expect(scraper.collect()).rejects.toThrow("DOM extraction failed unexpectedly");

    expect(pageSlot.ref?.closed).toBe(true);
    expect(browser.closed).toBe(true);
  });

  it("closes page and browser even when parsePopularTransactionRows throws", async () => {
    const pageSlot: { ref: FakeCdpPage | null } = { ref: null };
    const browser = new FakeCdpBrowser(() => {
      const page = makeFakeCdpPage();
      pageSlot.ref = page;
      return page;
    });

    const badRow: PopularTransactionRow = {
      postedDate: "not-a-date",
      effectiveDate: "01/01/2025",
      description: "TEST",
      amount: "$100.00",
    };

    const scraper = createPopularCdpScraper({
      cdpUrl: "http://127.0.0.1:9222",
      clock: () => new Date("2025-01-01T04:00:00Z"),
      connect: async (cdpEndpoint: string) => { void cdpEndpoint; return browser; },
      collectRows: async () => ({ kind: "rows" as const, rows: [badRow] }),
    });

    await expect(scraper.collect()).rejects.toThrow();

    expect(pageSlot.ref?.closed).toBe(true);
    expect(browser.closed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createPopularCdpScraper — lazy connect (construction must not connect)
// ---------------------------------------------------------------------------

describe("createPopularCdpScraper — lazy connect", () => {
  it("does not call connect at construction time", () => {
    let connectCalled = false;
    createPopularCdpScraper({
      cdpUrl: "http://127.0.0.1:9222",
      clock: () => new Date(),
      connect: async (cdpEndpoint: string) => {
        void cdpEndpoint;
        connectCalled = true;
        throw new Error("should not be called");
      },
      collectRows: async () => ({ kind: "rows" as const, rows: [] }),
    });
    expect(connectCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CDP adapter — openDashboardAccount and pause
// ---------------------------------------------------------------------------

describe("CdpPopularPortalPage — openDashboardAccount", () => {
  it("calls page.evaluate with the exact product/currency args and returns the boolean result", async () => {
    // The evaluate stub returns true (row found) when called
    const page = makeFakeCdpPage({ evaluateResult: true });
    const scraper = createPopularCdpScraper({
      cdpUrl: "http://127.0.0.1:9222",
      clock: () => new Date("2025-01-01T04:00:00Z"),
      connect: async () => new FakeCdpBrowser(() => page),
      // Use the real collectRows flow so openDashboardAccount IS called
      // (inject a collectRows stub that calls the real page methods we care about)
      collectRows: async (portalPage) => {
        // Directly call openDashboardAccount to verify the CDP adapter plumbs it correctly
        const found = await portalPage.openDashboardAccount("Corriente", "RD$");
        // The page.evaluate stub returns true
        return found
          ? { kind: "rows" as const, rows: FIXTURE_ROWS }
          : { kind: "needs_admin_action" as const, safeErrorSummary: "Bank account row not found on dashboard" };
      },
    });

    const result = await scraper.collect();

    expect(result.status).toBe("collected");
    // Verify evaluate was called with the args
    expect(page.evaluateCalls).toHaveLength(1);
    const call = page.evaluateCalls[0];
    expect(call.arg).toEqual({ product: "Corriente", currency: "RD$" });
  });

  it("returns false when evaluate returns false (row not found)", async () => {
    const page = makeFakeCdpPage({ evaluateResult: false });
    const scraper = createPopularCdpScraper({
      cdpUrl: "http://127.0.0.1:9222",
      clock: () => new Date("2025-01-01T04:00:00Z"),
      connect: async () => new FakeCdpBrowser(() => page),
      collectRows: async (portalPage) => {
        const found = await portalPage.openDashboardAccount("Corriente", "RD$");
        return found
          ? { kind: "rows" as const, rows: [] }
          : { kind: "needs_admin_action" as const, safeErrorSummary: "Bank account row not found on dashboard" };
      },
    });

    const result = await scraper.collect();

    expect(result.status).toBe("needs_admin_action");
    expect(result.safeErrorSummary).toBe("Bank account row not found on dashboard");
  });

  it("passes productText and currencyText as args to evaluate (not interpolated into function source)", async () => {
    // Verify the args object is passed correctly and the evaluate fn receives it.
    // This guards against string interpolation into the evaluate source (which
    // would break for inputs containing special characters and prevent sandboxing).
    const page = makeFakeCdpPage({ evaluateResult: true });
    const scraper = createPopularCdpScraper({
      cdpUrl: "http://127.0.0.1:9222",
      clock: () => new Date("2025-01-01T04:00:00Z"),
      connect: async () => new FakeCdpBrowser(() => page),
      collectRows: async (portalPage) => {
        await portalPage.openDashboardAccount("Corriente", "RD$");
        return { kind: "rows" as const, rows: [] };
      },
    });

    await scraper.collect();

    // The arg must be a plain object with product/currency (not undefined/null)
    expect(page.evaluateCalls).toHaveLength(1);
    const arg = page.evaluateCalls[0].arg as { product: string; currency: string };
    expect(arg).toMatchObject({ product: "Corriente", currency: "RD$" });
  });
});

describe("CdpPopularPortalPage — pause", () => {
  it("delegates pause(ms) to page.waitForTimeout(ms)", async () => {
    const page = makeFakeCdpPage();
    const scraper = createPopularCdpScraper({
      cdpUrl: "http://127.0.0.1:9222",
      clock: () => new Date("2025-01-01T04:00:00Z"),
      connect: async () => new FakeCdpBrowser(() => page),
      collectRows: async (portalPage) => {
        await portalPage.pause(1234);
        return { kind: "rows" as const, rows: [] };
      },
    });

    await scraper.collect();

    expect(page.waitForTimeoutCalls).toContain(1234);
  });
});

// ---------------------------------------------------------------------------
// extractResultsTableFromDocument — th/td quirk regression guard
//
// These tests exercise the real DOM extraction logic (not a fixture bypass)
// using a minimal fake document that satisfies the DocumentLike/ElementLike
// interface. A regression to `thead tr > th` would cause these tests to fail
// because the two <td scope="col"> header cells would be excluded, producing
// only 7 headers instead of 9.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Minimal fake DOM helpers
// ---------------------------------------------------------------------------

function makeSpan(text: string): ElementLike {
  return {
    textContent: text,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
}

function makeImg(): ElementLike {
  return {
    textContent: "",
    querySelector: () => null,
    querySelectorAll: () => [],
  };
}

/** Build a fake table cell (th or td) that contains a <span> for label text. */
function makeHeaderCell(tag: "th" | "td", label: string): ElementLike {
  const span = makeSpan(label);
  const cell: ElementLike & { _tag: string } = {
    _tag: tag,
    textContent: label,
    querySelector(sel: string): ElementLike | null {
      if (sel === "span") return span;
      return null;
    },
    querySelectorAll(): ArrayLike<ElementLike> {
      return [];
    },
  };
  return cell;
}

/** Build a fake <td> body cell with text and optional img. */
function makeBodyCell(text: string, hasImg = false): ElementLike {
  const img = hasImg ? makeImg() : null;
  const cell: ElementLike & { _tag: string } = {
    _tag: "td",
    textContent: text,
    querySelector(sel: string): ElementLike | null {
      if (sel === "img") return img;
      return null;
    },
    querySelectorAll(): ArrayLike<ElementLike> {
      return [];
    },
  };
  return cell;
}

/**
 * Build a minimal fake document containing a table.w-full whose thead has
 * the given header cells (mix of th and td) and whose tbody has one row with
 * the given body cells.
 */
function makeFakeDocument(
  headerCells: ElementLike[],
  bodyRowCells: ElementLike[],
): DocumentLike {
  const thRow: ElementLike = {
    textContent: "",
    querySelector: () => null,
    querySelectorAll(sel: string): ArrayLike<ElementLike> {
      // "thead tr > *" selects all direct child cells of the header row
      if (sel === "thead tr > *") return headerCells;
      return [];
    },
  };

  const bodyRow: ElementLike = {
    textContent: "",
    querySelector: () => null,
    querySelectorAll(sel: string): ArrayLike<ElementLike> {
      if (sel === "td") return bodyRowCells;
      return [];
    },
  };

  const table: ElementLike = {
    textContent: "",
    querySelector: () => null,
    querySelectorAll(sel: string): ArrayLike<ElementLike> {
      if (sel === "thead tr > *") return headerCells;
      if (sel === "tbody tr") return [bodyRow];
      return [];
    },
  };

  const doc: DocumentLike = {
    querySelector(sel: string): ElementLike | null {
      if (sel === "table.w-full") return table;
      return null;
    },
  };

  void thRow; // referenced structurally via closure
  return doc;
}

describe("extractResultsTableFromDocument — th/td header quirk", () => {
  it("includes td-scope-col header cells (Ver imagen, Detalle) when thead uses mixed th and td", () => {
    // 7 <th> headers + 2 <td scope="col"> headers — the real Popular DOM shape.
    const headers = [
      makeHeaderCell("th", "Fecha posteo"),
      makeHeaderCell("th", "Fecha efectiva"),
      makeHeaderCell("th", "Nro. de cheque"),
      makeHeaderCell("th", "Nro. de referencia"),
      makeHeaderCell("th", "Descripción"),
      makeHeaderCell("th", "Monto"),
      makeHeaderCell("th", "Balance"),
      makeHeaderCell("td", "Ver imagen"),  // <td scope="col"> in the real portal
      makeHeaderCell("td", "Detalle"),     // <td scope="col"> in the real portal
    ];

    const bodyRow = [
      makeBodyCell("01/01/2025"),
      makeBodyCell("01/01/2025"),
      makeBodyCell("0001000000001"),
      makeBodyCell(""),
      makeBodyCell("PAGO FICTICIO 001"),
      makeBodyCell("$-1,234.56"),
      makeBodyCell("$8,765.44"),
      makeBodyCell("", false), // Ver imagen — no img
      makeBodyCell("", true),  // Detalle — has img
    ];

    const doc = makeFakeDocument(headers, bodyRow);
    const result = extractResultsTableFromDocument(doc);

    expect(result).not.toBeNull();
    expect(result!.headers).toHaveLength(9);
    expect(result!.headers).toContain("Ver imagen");
    expect(result!.headers).toContain("Detalle");
  });

  it("returns only 7 headers when td-scope-col cells are absent (regression baseline for th-only scan)", () => {
    // Simulate what a th-only scan would see: 7 headers, no Ver imagen/Detalle.
    const thOnlyHeaders = [
      makeHeaderCell("th", "Fecha posteo"),
      makeHeaderCell("th", "Fecha efectiva"),
      makeHeaderCell("th", "Nro. de cheque"),
      makeHeaderCell("th", "Nro. de referencia"),
      makeHeaderCell("th", "Descripción"),
      makeHeaderCell("th", "Monto"),
      makeHeaderCell("th", "Balance"),
    ];

    const doc = makeFakeDocument(thOnlyHeaders, []);
    const result = extractResultsTableFromDocument(doc);

    expect(result).not.toBeNull();
    expect(result!.headers).toHaveLength(7);
    expect(result!.headers).not.toContain("Ver imagen");
    expect(result!.headers).not.toContain("Detalle");
  });

  it("returns null when table.w-full is absent from the document", () => {
    const doc: DocumentLike = { querySelector: () => null };
    expect(extractResultsTableFromDocument(doc)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveDefaultScraper — consumer-defaults.ts branching
// (tested separately in consumer-defaults-popular-cdp.test.ts)
// ---------------------------------------------------------------------------
