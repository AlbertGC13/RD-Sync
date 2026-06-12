import { describe, expect, it } from "vitest";

import {
  formatPopularPortalDate,
  buildPopularTransactionsUrl,
  collectPopularPortalRows,
  type PopularPortalPage,
  type PortalTableSnapshot,
} from "./popular";

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

  it("defaults to pageNumber=1 and itemsPerPage=20", () => {
    const date = new Date("2026-06-12T04:00:00Z");
    const url = buildPopularTransactionsUrl({ baseUrl, sDate: date, eDate: date });
    expect(url).toContain("pageNumber=1");
    expect(url).toContain("itemsPerPage=20");
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
  it("navigates to page 1 on the first call using the correct date params", async () => {
    const date = new Date("2026-06-12T04:00:00Z");
    const baseUrl = "https://ib.bpd.com.do";
    const page = new FakePopularPortalPage({
      currentUrl: "https://ib.bpd.com.do/accountdetails/transactions",
      waitForVisibleTextResult: true,
      pageSnapshots: [makeSinglePageSnapshot([SYNTHETIC_ROW_1])],
    });

    await collectPopularPortalRows(page, { baseUrl, sDate: date, eDate: date });

    expect(page.operations[0]).toMatch(/goto:.*pageNumber=1/);
  });

  it("paginates to page 2 when page 1 is full (itemsPerPage rows returned)", async () => {
    const date = new Date("2026-06-12T04:00:00Z");
    const baseUrl = "https://ib.bpd.com.do";
    const itemsPerPage = 2;
    const page1Rows = [SYNTHETIC_ROW_1, SYNTHETIC_ROW_2];
    const page2Rows = [SYNTHETIC_ROW_3];

    const page = new FakePopularPortalPage({
      currentUrl: "https://ib.bpd.com.do/accountdetails/transactions",
      waitForVisibleTextResult: true,
      pageSnapshots: [
        makeSinglePageSnapshot(page1Rows),
        makeSinglePageSnapshot(page2Rows),
      ],
    });

    const result = await collectPopularPortalRows(page, { baseUrl, sDate: date, eDate: date, itemsPerPage });

    expect(result.kind).toBe("rows");
    if (result.kind !== "rows") throw new Error("unreachable");
    expect(result.rows).toHaveLength(3);
    // First goto was page 1, second was page 2
    expect(page.operations[0]).toMatch(/goto:.*pageNumber=1/);
    expect(page.operations.find((op) => op.includes("pageNumber=2"))).toBeTruthy();
  });

  it("stops paginating when fewer than itemsPerPage rows are returned", async () => {
    const date = new Date("2026-06-12T04:00:00Z");
    const baseUrl = "https://ib.bpd.com.do";
    const itemsPerPage = 3;
    // Only 2 rows on first page → stop
    const page = new FakePopularPortalPage({
      currentUrl: "https://ib.bpd.com.do/accountdetails/transactions",
      waitForVisibleTextResult: true,
      pageSnapshots: [makeSinglePageSnapshot([SYNTHETIC_ROW_1, SYNTHETIC_ROW_2])],
    });

    const result = await collectPopularPortalRows(page, { baseUrl, sDate: date, eDate: date, itemsPerPage });

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
      currentUrl: "https://ib.bpd.com.do/accountdetails/transactions",
      waitForVisibleTextResult: true,
      pageSnapshots: [
        makeSinglePageSnapshot([SYNTHETIC_ROW_1]),
        makeSinglePageSnapshot([SYNTHETIC_ROW_2]),
        makeSinglePageSnapshot([SYNTHETIC_ROW_3]), // should never be fetched
      ],
    });

    const result = await collectPopularPortalRows(page, { baseUrl, sDate: date, eDate: date, itemsPerPage, maxPages });

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
  it("returns needs_admin_action when redirected away from transactions path (login redirect)", async () => {
    const date = new Date("2026-06-12T04:00:00Z");
    const baseUrl = "https://ib.bpd.com.do";
    // After goto, current URL is the login page
    const page = new FakePopularPortalPage({
      currentUrl: "https://ib.bpd.com.do/login",
      waitForVisibleTextResult: false,
      pageSnapshots: [],
    });

    const result = await collectPopularPortalRows(page, { baseUrl, sDate: date, eDate: date });

    expect(result.kind).toBe("needs_admin_action");
    if (result.kind !== "needs_admin_action") throw new Error("unreachable");
    expect(result.safeErrorSummary).toBe("Bank session expired or requires verification");
  });

  it("returns needs_admin_action when waitForVisibleText times out and no table is present", async () => {
    const date = new Date("2026-06-12T04:00:00Z");
    const baseUrl = "https://ib.bpd.com.do";
    const page = new FakePopularPortalPage({
      currentUrl: "https://ib.bpd.com.do/accountdetails/transactions",
      waitForVisibleTextResult: false, // timeout
      pageSnapshots: [], // no table
    });

    const result = await collectPopularPortalRows(page, { baseUrl, sDate: date, eDate: date });

    expect(result.kind).toBe("needs_admin_action");
    if (result.kind !== "needs_admin_action") throw new Error("unreachable");
    expect(result.safeErrorSummary).toBe("Bank portal did not render transaction results");
  });

  it("returns kind rows with empty array when table is present but has zero data rows", async () => {
    const date = new Date("2026-06-12T04:00:00Z");
    const baseUrl = "https://ib.bpd.com.do";
    const page = new FakePopularPortalPage({
      currentUrl: "https://ib.bpd.com.do/accountdetails/transactions",
      waitForVisibleTextResult: true,
      pageSnapshots: [makeSinglePageSnapshot([])], // zero rows
    });

    const result = await collectPopularPortalRows(page, { baseUrl, sDate: date, eDate: date });

    expect(result.kind).toBe("rows");
    if (result.kind !== "rows") throw new Error("unreachable");
    expect(result.rows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// collectPopularPortalRows — header mapping and DOM quirks
// ---------------------------------------------------------------------------

describe("collectPopularPortalRows — header mapping and data extraction", () => {
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

    const page = new FakePopularPortalPage({
      currentUrl: "https://ib.bpd.com.do/accountdetails/transactions",
      waitForVisibleTextResult: true,
      pageSnapshots: [shuffledSnapshot],
    });

    const result = await collectPopularPortalRows(page, { baseUrl, sDate: date, eDate: date });

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

    const page = new FakePopularPortalPage({
      currentUrl: "https://ib.bpd.com.do/accountdetails/transactions",
      waitForVisibleTextResult: true,
      pageSnapshots: [snapshot],
    });

    const result = await collectPopularPortalRows(page, { baseUrl, sDate: date, eDate: date });
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

    const page = new FakePopularPortalPage({
      currentUrl: "https://ib.bpd.com.do/accountdetails/transactions",
      waitForVisibleTextResult: true,
      pageSnapshots: [thOnlySnapshot],
    });

    const result = await collectPopularPortalRows(page, { baseUrl, sDate: date, eDate: date });

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

    const page = new FakePopularPortalPage({
      currentUrl: "https://ib.bpd.com.do/accountdetails/transactions",
      waitForVisibleTextResult: true,
      pageSnapshots: [snapshot],
    });

    const result = await collectPopularPortalRows(page, { baseUrl, sDate: date, eDate: date });
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

    const page = new FakePopularPortalPage({
      currentUrl: "https://ib.bpd.com.do/accountdetails/transactions",
      waitForVisibleTextResult: true,
      pageSnapshots: [snapshot],
    });

    const result = await collectPopularPortalRows(page, { baseUrl, sDate: date, eDate: date });
    expect(result.kind).toBe("rows");
    if (result.kind !== "rows") throw new Error("unreachable");
    expect(result.rows[0].checkNumber).toBe("0001000000001");
  });

  it("does NOT extract Balance — it is absent from result rows regardless of column presence", async () => {
    const date = new Date("2026-06-12T04:00:00Z");
    const baseUrl = "https://ib.bpd.com.do";
    const snapshot = makeStandardSnapshot([SYNTHETIC_ROW_1]);

    const page = new FakePopularPortalPage({
      currentUrl: "https://ib.bpd.com.do/accountdetails/transactions",
      waitForVisibleTextResult: true,
      pageSnapshots: [snapshot],
    });

    const result = await collectPopularPortalRows(page, { baseUrl, sDate: date, eDate: date });
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

    const page = new FakePopularPortalPage({
      currentUrl: "https://ib.bpd.com.do/accountdetails/transactions",
      waitForVisibleTextResult: true,
      pageSnapshots: [snapshot],
    });

    const result = await collectPopularPortalRows(page, { baseUrl, sDate: date, eDate: date });
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

    const page = new FakePopularPortalPage({
      currentUrl: "https://ib.bpd.com.do/accountdetails/transactions",
      waitForVisibleTextResult: true,
      pageSnapshots: [snapshot],
    });

    const result = await collectPopularPortalRows(page, { baseUrl, sDate: date, eDate: date });
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

    const page = new FakePopularPortalPage({
      currentUrl: "https://ib.bpd.com.do/accountdetails/transactions",
      waitForVisibleTextResult: true,
      pageSnapshots: [snapshot],
    });

    const result = await collectPopularPortalRows(page, { baseUrl, sDate: date, eDate: date });
    expect(result.kind).toBe("rows");
    if (result.kind !== "rows") throw new Error("unreachable");
    // The scraper returns the raw text value; parsePopularTransactionRows handles null conversion
    expect(result.rows[0].referenceNumber).toBe("");
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
      currentUrl: string;
      waitForVisibleTextResult: boolean;
      pageSnapshots: PortalTableSnapshot[];
    },
  ) {}

  async goto(url: string): Promise<void> {
    this.operations.push(`goto:${url}`);
  }

  async currentUrl(): Promise<string> {
    this.operations.push("currentUrl");
    return this.state.currentUrl;
  }

  async waitForVisibleText(text: string, timeoutMs: number): Promise<boolean> {
    this.operations.push(`waitForVisibleText:${text}:${timeoutMs}`);
    return this.state.waitForVisibleTextResult;
  }

  async readResultsTable(): Promise<PortalTableSnapshot | null> {
    this.operations.push("readResultsTable");
    const snapshot = this.state.pageSnapshots[this.snapshotIndex];
    if (snapshot !== undefined) {
      this.snapshotIndex++;
      return snapshot;
    }
    return null;
  }
}
