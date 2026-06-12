import { describe, expect, it } from "vitest";

import {
  formatPopularPortalDate,
  buildPopularTransactionsUrl,
  collectPopularPortalRows,
  type PopularPortalPage,
  type PortalTableSnapshot,
} from "./popular";

// ---------------------------------------------------------------------------
// Re-export for type checking: ensure openDashboardAccount and pause exist
// ---------------------------------------------------------------------------
// (checked structurally via FakePopularPortalPage below)

// ---------------------------------------------------------------------------
// formatPopularPortalDate
// ---------------------------------------------------------------------------

describe("formatPopularPortalDate", () => {
  it("formats a UTC midnight date into dd/mm/yyyy in America/Santo_Domingo (UTC-04:00)", () => {
    // 2026-06-12T04:00:00Z is 2026-06-12T00:00:00-04:00 in Santo Domingo
    const result = formatPopularPortalDate(new Date("2026-06-12T04:00:00Z"));
    expect(result).toBe("12/06/2026");
  });

  it("correctly handles a date that is a day earlier in UTC than in Santo Domingo", () => {
    // 2026-01-13T01:00:00Z is 2026-01-12T21:00:00-04:00 → still the 12th in SD
    const result = formatPopularPortalDate(new Date("2026-01-13T01:00:00Z"));
    expect(result).toBe("12/01/2026");
  });

  it("zero-pads day and month", () => {
    // 2026-05-01T04:00:00Z = 2026-05-01T00:00:00-04:00 in SD
    const result = formatPopularPortalDate(new Date("2026-05-01T04:00:00Z"));
    expect(result).toBe("01/05/2026");
  });
});

// ---------------------------------------------------------------------------
// buildPopularTransactionsUrl
// ---------------------------------------------------------------------------

describe("buildPopularTransactionsUrl", () => {
  const baseUrl = "https://ib.bpd.com.do";

  it("uses the /accountdetails/transactions path", () => {
    const date = new Date("2026-06-12T04:00:00Z");
    const url = buildPopularTransactionsUrl({ baseUrl, sDate: date, eDate: date });
    expect(url).toContain("/accountdetails/transactions");
  });

  it("encodes dates as dd%2Fmm%2Fyyyy (slash URL-encoded as %2F)", () => {
    const date = new Date("2026-06-12T04:00:00Z");
    const url = buildPopularTransactionsUrl({ baseUrl, sDate: date, eDate: date });
    expect(url).toContain("sDate=12%2F06%2F2026");
    expect(url).toContain("eDate=12%2F06%2F2026");
  });

  it("includes all required query parameters", () => {
    const date = new Date("2026-06-12T04:00:00Z");
    const url = buildPopularTransactionsUrl({ baseUrl, sDate: date, eDate: date });
    expect(url).toContain("accountType=Corriente");
    expect(url).toContain("currency=DOP");
    expect(url).toContain("filter=false");
  });

  it("defaults to pageNumber=1 and itemsPerPage=100", () => {
    const date = new Date("2026-06-12T04:00:00Z");
    const url = buildPopularTransactionsUrl({ baseUrl, sDate: date, eDate: date });
    expect(url).toContain("pageNumber=1");
    expect(url).toContain("itemsPerPage=100");
  });

  it("accepts custom pageNumber and itemsPerPage", () => {
    const date = new Date("2026-06-12T04:00:00Z");
    const url = buildPopularTransactionsUrl({ baseUrl, sDate: date, eDate: date, pageNumber: 3, itemsPerPage: 10 });
    expect(url).toContain("pageNumber=3");
    expect(url).toContain("itemsPerPage=10");
  });

  it("does not include literal slashes in the date values (must be %2F encoded)", () => {
    const date = new Date("2026-06-12T04:00:00Z");
    const url = buildPopularTransactionsUrl({ baseUrl, sDate: date, eDate: date });
    // Split off the path part and inspect query string
    const queryStart = url.indexOf("?");
    const query = url.slice(queryStart);
    // The query string must not contain raw slashes inside date values
    // sDate= and eDate= values must be encoded
    expect(query).not.toMatch(/sDate=\d{2}\/\d{2}\/\d{4}/);
    expect(query).not.toMatch(/eDate=\d{2}\/\d{2}\/\d{4}/);
  });
});

// ---------------------------------------------------------------------------
// collectPopularPortalRows — URL building during pagination
// ---------------------------------------------------------------------------

describe("collectPopularPortalRows — pagination URL construction", () => {
  it("navigates to dashboard first, then to page 1 on the transactions URL", async () => {
    const date = new Date("2026-06-12T04:00:00Z");
    const baseUrl = "https://ib.bpd.com.do";
    const page = new FakePopularPortalPage({
      dashboardUrl: `${baseUrl}/dashboard`,
      currentUrl: "https://ib.bpd.com.do/accountdetails/transactions",
      waitForVisibleTextResults: { Produto: true, "Fecha posteo": true },
      openDashboardAccountResult: true,
      pageSnapshots: [makeSinglePageSnapshot([SYNTHETIC_ROW_1])],
    });

    await collectPopularPortalRows(page, { baseUrl, sDate: date, eDate: date, warmupPauseMs: 0, settleIntervalMs: 0, settleFloorMs: 0, settleMaxMs: 0 });

    // First goto must be the dashboard
    expect(page.operations[0]).toMatch(/goto:.*\/dashboard/);
    // Later there must be a goto to the transactions URL with pageNumber=1
    expect(page.operations.find((op) => /goto:.*pageNumber=1/.test(op))).toBeTruthy();
  });

  it("uses itemsPerPage=100 by default in the transactions URL", async () => {
    const date = new Date("2026-06-12T04:00:00Z");
    const baseUrl = "https://ib.bpd.com.do";
    const page = new FakePopularPortalPage({
      dashboardUrl: `${baseUrl}/dashboard`,
      currentUrl: "https://ib.bpd.com.do/accountdetails/transactions",
      waitForVisibleTextResults: { Produto: true, "Fecha posteo": true },
      openDashboardAccountResult: true,
      pageSnapshots: [makeSinglePageSnapshot([SYNTHETIC_ROW_1])],
    });

    await collectPopularPortalRows(page, { baseUrl, sDate: date, eDate: date, warmupPauseMs: 0, settleIntervalMs: 0, settleFloorMs: 0, settleMaxMs: 0 });

    expect(page.operations.find((op) => op.includes("itemsPerPage=100"))).toBeTruthy();
  });

  it("paginates to page 2 when page 1 is full (itemsPerPage rows returned)", async () => {
    const date = new Date("2026-06-12T04:00:00Z");
    const baseUrl = "https://ib.bpd.com.do";
    const itemsPerPage = 2;
    const page1Rows = [SYNTHETIC_ROW_1, SYNTHETIC_ROW_2];
    const page2Rows = [SYNTHETIC_ROW_3];

    const page = new FakePopularPortalPage({
      dashboardUrl: `${baseUrl}/dashboard`,
      currentUrl: "https://ib.bpd.com.do/accountdetails/transactions",
      waitForVisibleTextResults: { Produto: true, "Fecha posteo": true },
      openDashboardAccountResult: true,
      pageSnapshots: [
        makeSinglePageSnapshot(page1Rows),
        makeSinglePageSnapshot(page2Rows),
      ],
    });

    const result = await collectPopularPortalRows(page, { baseUrl, sDate: date, eDate: date, itemsPerPage, warmupPauseMs: 0, settleIntervalMs: 0, settleFloorMs: 0, settleMaxMs: 0 });

    expect(result.kind).toBe("rows");
    if (result.kind !== "rows") throw new Error("unreachable");
    expect(result.rows).toHaveLength(3);
    // First goto was dashboard, then page 1, then page 2
    expect(page.operations[0]).toMatch(/goto:.*\/dashboard/);
    expect(page.operations.find((op) => op.includes("pageNumber=2"))).toBeTruthy();
  });

  it("stops paginating when fewer than itemsPerPage rows are returned", async () => {
    const date = new Date("2026-06-12T04:00:00Z");
    const baseUrl = "https://ib.bpd.com.do";
    const itemsPerPage = 3;
    // Only 2 rows on first page → stop
    const page = new FakePopularPortalPage({
      dashboardUrl: `${baseUrl}/dashboard`,
      currentUrl: "https://ib.bpd.com.do/accountdetails/transactions",
      waitForVisibleTextResults: { Produto: true, "Fecha posteo": true },
      openDashboardAccountResult: true,
      pageSnapshots: [makeSinglePageSnapshot([SYNTHETIC_ROW_1, SYNTHETIC_ROW_2])],
    });

    const result = await collectPopularPortalRows(page, { baseUrl, sDate: date, eDate: date, itemsPerPage, warmupPauseMs: 0, settleIntervalMs: 0, settleFloorMs: 0, settleMaxMs: 0 });

    expect(result.kind).toBe("rows");
    if (result.kind !== "rows") throw new Error("unreachable");
    expect(result.rows).toHaveLength(2);
    // Should not have navigated to page 2
    expect(page.operations.some((op) => op.includes("pageNumber=2"))).toBe(false);
  });

  it("enforces maxPages cap and stops before reading page maxPages+1", async () => {
    const date = new Date("2026-06-12T04:00:00Z");
    const baseUrl = "https://ib.bpd.com.do";
    const itemsPerPage = 1;
    const maxPages = 2;
    // Every page is full (1 row = itemsPerPage)
    const page = new FakePopularPortalPage({
      dashboardUrl: `${baseUrl}/dashboard`,
      currentUrl: "https://ib.bpd.com.do/accountdetails/transactions",
      waitForVisibleTextResults: { Produto: true, "Fecha posteo": true },
      openDashboardAccountResult: true,
      pageSnapshots: [
        makeSinglePageSnapshot([SYNTHETIC_ROW_1]),
        makeSinglePageSnapshot([SYNTHETIC_ROW_2]),
        makeSinglePageSnapshot([SYNTHETIC_ROW_3]), // should never be fetched
      ],
    });

    const result = await collectPopularPortalRows(page, { baseUrl, sDate: date, eDate: date, itemsPerPage, maxPages, warmupPauseMs: 0, settleIntervalMs: 0, settleFloorMs: 0, settleMaxMs: 0 });

    expect(result.kind).toBe("rows");
    if (result.kind !== "rows") throw new Error("unreachable");
    expect(result.rows).toHaveLength(2); // only 2 pages read
    // No page 3
    expect(page.operations.some((op) => op.includes("pageNumber=3"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// collectPopularPortalRows — state detection
// ---------------------------------------------------------------------------

describe("collectPopularPortalRows — state detection", () => {
  it("returns needs_admin_action when dashboard redirects away (login redirect during warm-up)", async () => {
    const date = new Date("2026-06-12T04:00:00Z");
    const baseUrl = "https://ib.bpd.com.do";
    // currentUrl returns the login page (not /dashboard), triggering redirect detection
    const page = new FakePopularPortalPage({
      dashboardUrl: `${baseUrl}/login`,
      currentUrl: "https://ib.bpd.com.do/login",
      waitForVisibleTextResults: {},
      openDashboardAccountResult: false,
      pageSnapshots: [],
    });

    const result = await collectPopularPortalRows(page, { baseUrl, sDate: date, eDate: date, warmupPauseMs: 0, settleIntervalMs: 0, settleFloorMs: 0, settleMaxMs: 0 });

    expect(result.kind).toBe("needs_admin_action");
    if (result.kind !== "needs_admin_action") throw new Error("unreachable");
    expect(result.safeErrorSummary).toBe("Bank session expired or requires verification");
  });

  it("returns needs_admin_action when dashboard never renders (Producto wait times out)", async () => {
    const date = new Date("2026-06-12T04:00:00Z");
    const baseUrl = "https://ib.bpd.com.do";
    const page = new FakePopularPortalPage({
      dashboardUrl: `${baseUrl}/dashboard`,
      currentUrl: "https://ib.bpd.com.do/accountdetails/transactions",
      waitForVisibleTextResults: { Produto: false }, // "Producto" times out
      openDashboardAccountResult: false,
      pageSnapshots: [],
    });

    const result = await collectPopularPortalRows(page, { baseUrl, sDate: date, eDate: date, warmupPauseMs: 0, settleIntervalMs: 0, settleFloorMs: 0, settleMaxMs: 0 });

    expect(result.kind).toBe("needs_admin_action");
    if (result.kind !== "needs_admin_action") throw new Error("unreachable");
    expect(result.safeErrorSummary).toBe("Bank dashboard did not render");
  });

  it("returns needs_admin_action when openDashboardAccount returns false (row not found)", async () => {
    const date = new Date("2026-06-12T04:00:00Z");
    const baseUrl = "https://ib.bpd.com.do";
    const page = new FakePopularPortalPage({
      dashboardUrl: `${baseUrl}/dashboard`,
      currentUrl: "https://ib.bpd.com.do/accountdetails/transactions",
      waitForVisibleTextResults: { Produto: true, "Fecha posteo": true },
      openDashboardAccountResult: false, // no matching row
      pageSnapshots: [],
    });

    const result = await collectPopularPortalRows(page, { baseUrl, sDate: date, eDate: date, warmupPauseMs: 0, settleIntervalMs: 0, settleFloorMs: 0, settleMaxMs: 0 });

    expect(result.kind).toBe("needs_admin_action");
    if (result.kind !== "needs_admin_action") throw new Error("unreachable");
    expect(result.safeErrorSummary).toBe("Bank account row not found on dashboard");
  });

  it("returns needs_admin_action when waitForVisibleText('Fecha posteo') times out and no table is present", async () => {
    const date = new Date("2026-06-12T04:00:00Z");
    const baseUrl = "https://ib.bpd.com.do";
    const page = new FakePopularPortalPage({
      dashboardUrl: `${baseUrl}/dashboard`,
      currentUrl: "https://ib.bpd.com.do/accountdetails/transactions",
      waitForVisibleTextResults: { Produto: true, "Fecha posteo": false }, // transactions page times out
      openDashboardAccountResult: true,
      pageSnapshots: [], // no table
    });

    const result = await collectPopularPortalRows(page, { baseUrl, sDate: date, eDate: date, warmupPauseMs: 0, settleIntervalMs: 0, settleFloorMs: 0, settleMaxMs: 0 });

    expect(result.kind).toBe("needs_admin_action");
    if (result.kind !== "needs_admin_action") throw new Error("unreachable");
    expect(result.safeErrorSummary).toBe("Bank portal did not render transaction results");
  });

  it("returns kind rows with empty array when table is present but has zero data rows", async () => {
    const date = new Date("2026-06-12T04:00:00Z");
    const baseUrl = "https://ib.bpd.com.do";
    const page = new FakePopularPortalPage({
      dashboardUrl: `${baseUrl}/dashboard`,
      currentUrl: "https://ib.bpd.com.do/accountdetails/transactions",
      waitForVisibleTextResults: { Produto: true, "Fecha posteo": true },
      openDashboardAccountResult: true,
      pageSnapshots: [makeSinglePageSnapshot([])], // zero rows — settle floor protects from false empty
    });

    const result = await collectPopularPortalRows(page, { baseUrl, sDate: date, eDate: date, warmupPauseMs: 0, settleIntervalMs: 0, settleFloorMs: 0, settleMaxMs: 0 });

    expect(result.kind).toBe("rows");
    if (result.kind !== "rows") throw new Error("unreachable");
    expect(result.rows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// collectPopularPortalRows — header mapping and DOM quirks
// ---------------------------------------------------------------------------

describe("collectPopularPortalRows — header mapping and data extraction", () => {
  /** Helper: make a page in the happy-path warm-up state with the given snapshot(s). */
  function makeHappyPage(baseUrl: string, snapshots: PortalTableSnapshot[]): FakePopularPortalPage {
    return new FakePopularPortalPage({
      dashboardUrl: `${baseUrl}/dashboard`,
      currentUrl: "https://ib.bpd.com.do/accountdetails/transactions",
      waitForVisibleTextResults: { Produto: true, "Fecha posteo": true },
      openDashboardAccountResult: true,
      pageSnapshots: snapshots,
    });
  }

  const FAST_OPTS = { warmupPauseMs: 0, settleIntervalMs: 0, settleFloorMs: 0, settleMaxMs: 0 };

  it("maps columns by header text, not by index position", async () => {
    const date = new Date("2026-06-12T04:00:00Z");
    const baseUrl = "https://ib.bpd.com.do";
    // Shuffled header order: put Monto before Descripción
    const shuffledSnapshot = makeSnapshotWithHeaders(
      ["Nro. de cheque", "Monto", "Fecha efectiva", "Nro. de referencia", "Descripción", "Fecha posteo", "Balance", "Ver imagen", "Detalle"],
      [
        [
          { text: "0001000000001", hasImage: false },
          { text: "$-1,234.56", hasImage: false },
          { text: "01/01/2025", hasImage: false },
          { text: "", hasImage: false },
          { text: "PAGO FICTICIO 001", hasImage: false },
          { text: "01/01/2025", hasImage: false },
          { text: "$8,765.44", hasImage: false },
          { text: "", hasImage: false },
          { text: "", hasImage: true },
        ],
      ],
    );

    const page = makeHappyPage(baseUrl, [shuffledSnapshot]);
    const result = await collectPopularPortalRows(page, { baseUrl, sDate: date, eDate: date, ...FAST_OPTS });

    expect(result.kind).toBe("rows");
    if (result.kind !== "rows") throw new Error("unreachable");
    const [row] = result.rows;
    expect(row.postedDate).toBe("01/01/2025");
    expect(row.effectiveDate).toBe("01/01/2025");
    expect(row.amount).toBe("$-1,234.56");
    expect(row.checkNumber).toBe("0001000000001");
    expect(row.description).toBe("PAGO FICTICIO 001");
  });

  it("exercises the th/td quirk: td-scope headers (Ver imagen, Detalle) are included in snapshot headers", async () => {
    const date = new Date("2026-06-12T04:00:00Z");
    const baseUrl = "https://ib.bpd.com.do";
    // Standard layout with all 9 headers including the td ones
    const snapshot = makeStandardSnapshot([SYNTHETIC_ROW_1]);
    // Verify the snapshot we use actually includes the td-scope headers
    expect(snapshot.headers).toContain("Ver imagen");
    expect(snapshot.headers).toContain("Detalle");

    const page = makeHappyPage(baseUrl, [snapshot]);
    const result = await collectPopularPortalRows(page, { baseUrl, sDate: date, eDate: date, ...FAST_OPTS });
    expect(result.kind).toBe("rows");
  });

  it("a th-only scan (7 headers) would misalign columns 8 and 9 — our mapping must include all 9", async () => {
    const date = new Date("2026-06-12T04:00:00Z");
    const baseUrl = "https://ib.bpd.com.do";
    // Simulate what happens if only th elements are scanned (7 headers instead of 9)
    const thOnlySnapshot: PortalTableSnapshot = {
      headers: [
        "Fecha posteo", "Fecha efectiva", "Nro. de cheque", "Nro. de referencia",
        "Descripción", "Monto", "Balance",
        // missing "Ver imagen" and "Detalle" — this is the broken scan
      ],
      rows: [
        [
          { text: "01/01/2025", hasImage: false },
          { text: "01/01/2025", hasImage: false },
          { text: "", hasImage: false },
          { text: "", hasImage: false },
          { text: "PAGO FICTICIO 001", hasImage: false },
          { text: "$500.00", hasImage: false },
          { text: "$8,765.44", hasImage: false },
          // These two cells exist in DOM but have no header in the broken scan
          // so imageAvailable/detailAvailable cannot be mapped
          { text: "", hasImage: false },
          { text: "", hasImage: true },
        ],
      ],
    };

    const page = makeHappyPage(baseUrl, [thOnlySnapshot]);
    const result = await collectPopularPortalRows(page, { baseUrl, sDate: date, eDate: date, ...FAST_OPTS });

    expect(result.kind).toBe("rows");
    if (result.kind !== "rows") throw new Error("unreachable");
    // With only 7 headers the Detalle hasImage (true) is at index 8 but there's
    // no "Detalle" key in the header map → detailAvailable must be false (unmapped)
    expect(result.rows[0].detailAvailable).toBe(false);
    // With a correct 9-header snapshot (via makeStandardSnapshot), detailAvailable IS true
  });

  it("trims trailing whitespace from all cell text values", async () => {
    const date = new Date("2026-06-12T04:00:00Z");
    const baseUrl = "https://ib.bpd.com.do";
    const snapshot = makeStandardSnapshot([
      { ...SYNTHETIC_ROW_1, checkNumber: "0001000000001 " }, // trailing space
    ]);

    const page = makeHappyPage(baseUrl, [snapshot]);
    const result = await collectPopularPortalRows(page, { baseUrl, sDate: date, eDate: date, ...FAST_OPTS });
    expect(result.kind).toBe("rows");
    if (result.kind !== "rows") throw new Error("unreachable");
    expect(result.rows[0].checkNumber).toBe("0001000000001");
  });

  it("keeps checkNumber leading zeros as a string", async () => {
    const date = new Date("2026-06-12T04:00:00Z");
    const baseUrl = "https://ib.bpd.com.do";
    const snapshot = makeStandardSnapshot([
      { ...SYNTHETIC_ROW_1, checkNumber: "0001000000001" },
    ]);

    const page = makeHappyPage(baseUrl, [snapshot]);
    const result = await collectPopularPortalRows(page, { baseUrl, sDate: date, eDate: date, ...FAST_OPTS });
    expect(result.kind).toBe("rows");
    if (result.kind !== "rows") throw new Error("unreachable");
    expect(result.rows[0].checkNumber).toBe("0001000000001");
  });

  it("does NOT extract Balance — it is absent from result rows regardless of column presence", async () => {
    const date = new Date("2026-06-12T04:00:00Z");
    const baseUrl = "https://ib.bpd.com.do";
    const snapshot = makeStandardSnapshot([SYNTHETIC_ROW_1]);

    const page = makeHappyPage(baseUrl, [snapshot]);
    const result = await collectPopularPortalRows(page, { baseUrl, sDate: date, eDate: date, ...FAST_OPTS });
    expect(result.kind).toBe("rows");
    if (result.kind !== "rows") throw new Error("unreachable");
    const row = result.rows[0];
    // balance is not a field on PopularTransactionRow — verify it is absent at runtime too
    expect(Object.prototype.hasOwnProperty.call(row, "balance")).toBe(false);
    // The balance value from the snapshot must not appear anywhere in the serialized row
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain("8,765.44");
  });

  it("maps imageAvailable from img presence in the Ver imagen cell", async () => {
    const date = new Date("2026-06-12T04:00:00Z");
    const baseUrl = "https://ib.bpd.com.do";
    // Row with imageAvailable=true (hasImage in Ver imagen column)
    const snapshot = makeStandardSnapshot([
      { ...SYNTHETIC_ROW_1, imageAvailable: true, detailAvailable: false },
    ]);

    const page = makeHappyPage(baseUrl, [snapshot]);
    const result = await collectPopularPortalRows(page, { baseUrl, sDate: date, eDate: date, ...FAST_OPTS });
    expect(result.kind).toBe("rows");
    if (result.kind !== "rows") throw new Error("unreachable");
    expect(result.rows[0].imageAvailable).toBe(true);
    expect(result.rows[0].detailAvailable).toBe(false);
  });

  it("maps detailAvailable from img presence in the Detalle cell", async () => {
    const date = new Date("2026-06-12T04:00:00Z");
    const baseUrl = "https://ib.bpd.com.do";
    const snapshot = makeStandardSnapshot([
      { ...SYNTHETIC_ROW_1, imageAvailable: false, detailAvailable: true },
    ]);

    const page = makeHappyPage(baseUrl, [snapshot]);
    const result = await collectPopularPortalRows(page, { baseUrl, sDate: date, eDate: date, ...FAST_OPTS });
    expect(result.kind).toBe("rows");
    if (result.kind !== "rows") throw new Error("unreachable");
    expect(result.rows[0].detailAvailable).toBe(true);
    expect(result.rows[0].imageAvailable).toBe(false);
  });

  it("maps an empty reference cell to an empty string (not null at this layer)", async () => {
    const date = new Date("2026-06-12T04:00:00Z");
    const baseUrl = "https://ib.bpd.com.do";
    const snapshot = makeStandardSnapshot([
      { ...SYNTHETIC_ROW_1, referenceNumber: "" },
    ]);

    const page = makeHappyPage(baseUrl, [snapshot]);
    const result = await collectPopularPortalRows(page, { baseUrl, sDate: date, eDate: date, ...FAST_OPTS });
    expect(result.kind).toBe("rows");
    if (result.kind !== "rows") throw new Error("unreachable");
    // The scraper returns the raw text value; parsePopularTransactionRows handles null conversion
    expect(result.rows[0].referenceNumber).toBe("");
  });
});

// ---------------------------------------------------------------------------
// collectPopularPortalRows — warm-up operation order
// ---------------------------------------------------------------------------

describe("collectPopularPortalRows — warm-up operation order", () => {
  it("executes: goto(dashboard) → waitForVisibleText('Producto') → openDashboardAccount → pause → goto(transactions)", async () => {
    const date = new Date("2026-06-12T04:00:00Z");
    const baseUrl = "https://ib.bpd.com.do";
    const page = new FakePopularPortalPage({
      dashboardUrl: `${baseUrl}/dashboard`,
      currentUrl: "https://ib.bpd.com.do/accountdetails/transactions",
      waitForVisibleTextResults: { Produto: true, "Fecha posteo": true },
      openDashboardAccountResult: true,
      pageSnapshots: [makeSinglePageSnapshot([SYNTHETIC_ROW_1])],
    });

    await collectPopularPortalRows(page, { baseUrl, sDate: date, eDate: date, warmupPauseMs: 42, settleIntervalMs: 0, settleFloorMs: 0, settleMaxMs: 100 });

    // Operation 0 must be goto dashboard
    expect(page.operations[0]).toMatch(/goto:.*\/dashboard/);
    // currentUrl is called after dashboard goto
    const currentUrlIdx = page.operations.findIndex((op) => op === "currentUrl");
    expect(currentUrlIdx).toBeGreaterThan(0);
    // waitForVisibleText("Producto") happens before openDashboardAccount
    const waitProductoIdx = page.operations.findIndex((op) => op.includes("waitForVisibleText:Producto"));
    const openAccountIdx = page.operations.findIndex((op) => op === "openDashboardAccount:Corriente:RD$");
    expect(waitProductoIdx).toBeGreaterThan(0);
    expect(openAccountIdx).toBeGreaterThan(waitProductoIdx);
    // pause(42) happens after openDashboardAccount
    const pauseIdx = page.operations.findIndex((op) => op === "pause:42");
    expect(pauseIdx).toBeGreaterThan(openAccountIdx);
    // transactions goto happens after the warmup
    const transactionsGotoIdx = page.operations.findIndex((op) => /goto:.*pageNumber=1/.test(op));
    expect(transactionsGotoIdx).toBeGreaterThan(pauseIdx);
  });
});

// ---------------------------------------------------------------------------
// collectPopularPortalRows — settle loop
// ---------------------------------------------------------------------------

describe("collectPopularPortalRows — settle loop", () => {
  it("settle: sequence [0, 0, 4, 4] → accepts 4 rows (no false empty)", async () => {
    const date = new Date("2026-06-12T04:00:00Z");
    const baseUrl = "https://ib.bpd.com.do";
    // The fake returns different snapshots per readResultsTable call.
    // The loop advances past [0,0] because the next snapshot in sequence returns
    // 4 rows — the floor is not the mechanism here. To test the floor actually
    // blocking an all-zero sequence, see the separate "settle zero floor" test.
    const page = new FakePopularPortalPage({
      dashboardUrl: `${baseUrl}/dashboard`,
      currentUrl: "https://ib.bpd.com.do/accountdetails/transactions",
      waitForVisibleTextResults: { Produto: true, "Fecha posteo": true },
      openDashboardAccountResult: true,
      pageSnapshots: [
        makeSinglePageSnapshot([]),           // poll 1: 0 rows
        makeSinglePageSnapshot([]),           // poll 2: 0 rows
        makeSinglePageSnapshot([SYNTHETIC_ROW_1, SYNTHETIC_ROW_2, SYNTHETIC_ROW_3, SYNTHETIC_ROW_1]), // poll 3: 4 rows
        makeSinglePageSnapshot([SYNTHETIC_ROW_1, SYNTHETIC_ROW_2, SYNTHETIC_ROW_3, SYNTHETIC_ROW_1]), // poll 4: 4 rows (stable)
        // Extra snapshots (last one is repeated by the fake when exhausted)
        makeSinglePageSnapshot([SYNTHETIC_ROW_1, SYNTHETIC_ROW_2, SYNTHETIC_ROW_3, SYNTHETIC_ROW_1]),
      ],
    });

    const result = await collectPopularPortalRows(page, {
      baseUrl, sDate: date, eDate: date,
      itemsPerPage: 100,
      warmupPauseMs: 0,
      settleIntervalMs: 0,
      settleFloorMs: 50,   // irrelevant for this case; non-zero stable row count is accepted immediately
      settleMaxMs: 10000,
    });

    expect(result.kind).toBe("rows");
    if (result.kind !== "rows") throw new Error("unreachable");
    expect(result.rows).toHaveLength(4);
  });

  it("settle zero floor: if all reads return 0 rows, accepts empty only after floor elapsed", async () => {
    const date = new Date("2026-06-12T04:00:00Z");
    const baseUrl = "https://ib.bpd.com.do";
    // Unlimited snapshots of 0 rows
    const page = new FakePopularPortalPage({
      dashboardUrl: `${baseUrl}/dashboard`,
      currentUrl: "https://ib.bpd.com.do/accountdetails/transactions",
      waitForVisibleTextResults: { Produto: true, "Fecha posteo": true },
      openDashboardAccountResult: true,
      pageSnapshots: Array.from({ length: 10 }, () => makeSinglePageSnapshot([])),
    });

    const result = await collectPopularPortalRows(page, {
      baseUrl, sDate: date, eDate: date,
      warmupPauseMs: 0,
      settleIntervalMs: 0,
      settleFloorMs: 100,  // floor > 0 → must wait at least once before accepting 0.
      // NOTE: This test relies on real wall-clock time: settleIntervalMs=0 means
      // the loop spins on microtasks. The 100ms floor is crossed because Node's
      // event loop accumulates real elapsed time over many async iterations.
      // The test is NOT clock-isolated. On a heavily loaded CI runner it may
      // take longer; it will flap if a future change makes the loop terminate
      // before 100ms of real time elapses.
      settleMaxMs: 10000,
    });

    expect(result.kind).toBe("rows");
    if (result.kind !== "rows") throw new Error("unreachable");
    expect(result.rows).toHaveLength(0);
    // At least one pause call must have been made (the settle floor)
    const pauseCalls = page.operations.filter((op) => op.startsWith("pause:"));
    expect(pauseCalls.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Synthetic row definitions (faithful structure, synthetic values)
// ---------------------------------------------------------------------------

interface SyntheticRow {
  postedDate: string;
  effectiveDate: string;
  checkNumber?: string;
  referenceNumber?: string;
  description: string;
  amount: string;
  balance: string;
  imageAvailable?: boolean;
  detailAvailable?: boolean;
}

const SYNTHETIC_ROW_1: SyntheticRow = {
  postedDate: "01/01/2025",
  effectiveDate: "01/01/2025",
  checkNumber: "0001000000001",
  referenceNumber: "",
  description: "PAGO FICTICIO 001 EJEMPLO",
  amount: "$-1,234.56",
  balance: "$8,765.44",
  imageAvailable: false,
  detailAvailable: true,
};

const SYNTHETIC_ROW_2: SyntheticRow = {
  postedDate: "02/01/2025",
  effectiveDate: "02/01/2025",
  checkNumber: "0002000000002",
  referenceNumber: "",
  description: "DEPOSITO FICTICIO 002 EJEMPLO",
  amount: "$4,000.00",
  balance: "$12,765.44",
  imageAvailable: false,
  detailAvailable: true,
};

const SYNTHETIC_ROW_3: SyntheticRow = {
  postedDate: "03/01/2025",
  effectiveDate: "03/01/2025",
  checkNumber: "",
  referenceNumber: "",
  description: "TRANSFERENCIA FICTICIA 003",
  amount: "$-500.00",
  balance: "$12,265.44",
  imageAvailable: false,
  detailAvailable: false,
};

// ---------------------------------------------------------------------------
// Snapshot helpers
// ---------------------------------------------------------------------------

const STANDARD_HEADERS = [
  "Fecha posteo",
  "Fecha efectiva",
  "Nro. de cheque",
  "Nro. de referencia",
  "Descripción",
  "Monto",
  "Balance",
  "Ver imagen",
  "Detalle",
];

function syntheticRowToSnapshotRow(
  row: SyntheticRow,
): Array<{ text: string; hasImage: boolean }> {
  return [
    { text: row.postedDate, hasImage: false },
    { text: row.effectiveDate, hasImage: false },
    { text: row.checkNumber ?? "", hasImage: false },
    { text: row.referenceNumber ?? "", hasImage: false },
    { text: row.description, hasImage: false },
    { text: row.amount, hasImage: false },
    { text: row.balance, hasImage: false },
    { text: "", hasImage: row.imageAvailable ?? false },
    { text: "", hasImage: row.detailAvailable ?? false },
  ];
}

function makeStandardSnapshot(rows: SyntheticRow[]): PortalTableSnapshot {
  return {
    headers: STANDARD_HEADERS,
    rows: rows.map(syntheticRowToSnapshotRow),
  };
}

function makeSinglePageSnapshot(rows: SyntheticRow[]): PortalTableSnapshot {
  return makeStandardSnapshot(rows);
}

function makeSnapshotWithHeaders(
  headers: string[],
  rows: Array<Array<{ text: string; hasImage: boolean }>>,
): PortalTableSnapshot {
  return { headers, rows };
}

// ---------------------------------------------------------------------------
// FakePopularPortalPage — implements PopularPortalPage seam
// Recorded operations allow assertions on what was called and in what order.
// ---------------------------------------------------------------------------

class FakePopularPortalPage implements PopularPortalPage {
  readonly operations: string[] = [];
  private snapshotIndex = 0;

  constructor(
    private readonly state: {
      /** URL returned by currentUrl() when the caller is on the dashboard path */
      dashboardUrl: string;
      /** URL returned by currentUrl() at all other times (transactions path) */
      currentUrl: string;
      /**
       * Per-text results for waitForVisibleText.
       * Key "Produto" matches "Producto" (prefix match for brevity in tests).
       * Any missing key defaults to true.
       */
      waitForVisibleTextResults: Record<string, boolean>;
      openDashboardAccountResult: boolean;
      pageSnapshots: PortalTableSnapshot[];
    },
  ) {}

  async goto(url: string): Promise<void> {
    this.operations.push(`goto:${url}`);
  }

  async currentUrl(): Promise<string> {
    this.operations.push("currentUrl");
    // If the last goto was to a dashboard-like URL, return dashboardUrl
    const lastGoto = [...this.operations].reverse().find((op) => op.startsWith("goto:"));
    if (lastGoto !== undefined && lastGoto.includes("/dashboard")) {
      return this.state.dashboardUrl;
    }
    return this.state.currentUrl;
  }

  async waitForVisibleText(text: string, timeoutMs: number): Promise<boolean> {
    this.operations.push(`waitForVisibleText:${text}:${timeoutMs}`);
    // Match by prefix key "Produto" → matches "Producto"
    for (const [key, value] of Object.entries(this.state.waitForVisibleTextResults)) {
      if (text.startsWith(key) || key.startsWith(text.substring(0, 5))) {
        return value;
      }
    }
    return true; // default: visible
  }

  async openDashboardAccount(productText: string, currencyText: string): Promise<boolean> {
    this.operations.push(`openDashboardAccount:${productText}:${currencyText}`);
    return this.state.openDashboardAccountResult;
  }

  async pause(ms: number): Promise<void> {
    this.operations.push(`pause:${ms}`);
  }

  async readResultsTable(): Promise<PortalTableSnapshot | null> {
    this.operations.push("readResultsTable");
    const snapshot = this.state.pageSnapshots[this.snapshotIndex];
    if (snapshot !== undefined) {
      this.snapshotIndex++;
      return snapshot;
    }
    // When snapshots are exhausted, return last snapshot (for settle loop stability)
    const last = this.state.pageSnapshots[this.state.pageSnapshots.length - 1];
    return last ?? null;
  }
}
