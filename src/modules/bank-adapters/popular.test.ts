import { describe, expect, it } from "vitest";

import {
  parsePopularTransactionRows,
  popularPortalFixture,
  popularScraperProfile,
} from "./popular";

describe("popularScraperProfile", () => {
  it("models the screenshot flow for account selection and date-based search", () => {
    expect(popularPortalFixture.dashboard.accounts).toContainEqual({
      accountNumber: "0000000000",
      accountType: "Corriente",
      currency: "DOP",
    });
    expect(popularScraperProfile.selectors).toMatchObject({
      accountNumberText: "0000000000",
      fromDateInput: "input[name='sDate']",
      toDateInput: "input[name='eDate']",
      searchButtonText: "Buscar",
      resultsTable: "table:has-text('Fecha posteo')",
    });
    expect(popularScraperProfile.defaultSearchMode).toBe("current-day");
  });
});

describe("parsePopularTransactionRows", () => {
  it("normalizes Popular result rows into bank movements", () => {
    const movements = parsePopularTransactionRows(popularPortalFixture.transactions);

    expect(movements[1]).toMatchObject({
      bankId: "popular",
      accountFingerprint: "popular-0000000000",
      postedAt: "2025-01-01T00:00:00-04:00",
      amount: "97000.00",
      currency: "DOP",
      direction: "credit",
      reference: "0001000000001",
      concept: "DEPOSITO FICTICIO 002",
    });
    expect(movements[3]).toMatchObject({
      amount: "115500.00",
      direction: "debit",
      reference: "0003000000003",
      concept: "PAGO FICTICIO 004",
    });
  });

  it("keeps check/detail metadata but excludes bank balance values", () => {
    const [movement] = parsePopularTransactionRows([popularPortalFixture.transactions[1]]);

    expect(movement.metadata).toEqual({
      effectiveAt: "2025-01-01T00:00:00-04:00",
      checkNumber: "0001000000001",
      referenceNumber: null,
      imageAvailable: false,
      detailAvailable: true,
    });
    // balance must not appear anywhere in the serialized movement
    expect(JSON.stringify(movement)).not.toContain("balance");
  });

  it("rejects malformed Popular dates and amounts", () => {
    expect(() =>
      parsePopularTransactionRows([
        { ...popularPortalFixture.transactions[0], postedDate: "2025-01-01" },
      ]),
    ).toThrow("Invalid Popular date format");
    expect(() =>
      parsePopularTransactionRows([{ ...popularPortalFixture.transactions[0], amount: "RD$ --" }]),
    ).toThrow("Invalid Popular amount format");
  });
});
