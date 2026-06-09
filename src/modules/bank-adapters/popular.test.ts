import { describe, expect, it } from "vitest";

import {
  parsePopularTransactionRows,
  popularPortalFixture,
  popularScraperProfile,
} from "./popular";

describe("popularScraperProfile", () => {
  it("models the screenshot flow for account selection and date-based search", () => {
    expect(popularPortalFixture.dashboard.accounts).toContainEqual({
      accountNumber: "817985690",
      accountType: "Corriente",
      currency: "DOP",
    });
    expect(popularScraperProfile.selectors).toMatchObject({
      accountNumberText: "817985690",
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
      accountFingerprint: "popular-817985690",
      postedAt: "2026-05-11T00:00:00-04:00",
      amount: "97000.00",
      currency: "DOP",
      direction: "credit",
      reference: "0612915426447",
      concept: "BANCO POPULAR OFICINA EL SANTIAGO 612915426447 090526 DEP C TACTE BPD0344",
    });
    expect(movements[3]).toMatchObject({
      amount: "115500.00",
      direction: "debit",
      reference: "0000816840623",
      concept: "MB a 0816840623 lovely",
    });
  });

  it("keeps check/detail metadata but excludes bank balance values", () => {
    const [movement] = parsePopularTransactionRows([popularPortalFixture.transactions[1]]);

    expect(movement.metadata).toEqual({
      effectiveAt: "2026-05-09T00:00:00-04:00",
      checkNumber: "0612915426447",
      referenceNumber: null,
      imageAvailable: false,
      detailAvailable: true,
    });
    expect(JSON.stringify(movement)).not.toContain("$99,031.49");
  });

  it("rejects malformed Popular dates and amounts", () => {
    expect(() =>
      parsePopularTransactionRows([
        { ...popularPortalFixture.transactions[0], postedDate: "2026-05-11" },
      ]),
    ).toThrow("Invalid Popular date");
    expect(() =>
      parsePopularTransactionRows([{ ...popularPortalFixture.transactions[0], amount: "RD$ --" }]),
    ).toThrow("Invalid Popular amount");
  });
});
