import { describe, expect, it } from "vitest";

import type { IngestionScraper } from "../../worker/queues";
import {
  createPopularBankAdapter,
  parsePopularTransactionRows,
  popularBankCode,
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
    expect(popularScraperProfile.defaultSearchMode).toBe("recent-lookback-window");
    expect(popularPortalFixture.search.defaultSearchMode).toBe(
      popularScraperProfile.defaultSearchMode,
    );
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

describe("popularBankCode — canonical adapter identity", () => {
  it("exposes the immutable domain code (not the cuid DB id)", () => {
    expect(popularBankCode).toBe("popular");
  });
});

describe("createPopularBankAdapter", () => {
  // A deterministic scraper stub so the adapter test never touches a real CDP
  // endpoint or env. The adapter must hand back whatever scraper factory it is
  // given so the server wiring layer (registry) owns the heavyweight wiring.
  const stubScraper: IngestionScraper = {
    collect: async () => ({ status: "collected", movements: [] }),
  };
  const stubAutoLoginStrategy = {
    bankCode: "popular",
    autoLogin: async () => ({ status: "succeeded" as const }),
  };

  it("exposes Popular as a BankAdapter keyed by the canonical bankCode", () => {
    const adapter = createPopularBankAdapter({
      createScraper: () => stubScraper,
      createAutoLoginStrategy: () => stubAutoLoginStrategy,
    });

    expect(adapter.bankCode).toBe("popular");
  });

  it("delegates createScraper to the injected factory (no env/CDP coupling in the domain module)", () => {
    let called = 0;
    const adapter = createPopularBankAdapter({
      createScraper: () => {
        called += 1;
        return stubScraper;
      },
      createAutoLoginStrategy: () => stubAutoLoginStrategy,
    });

    const scraper = adapter.createScraper();
    expect(scraper).toBe(stubScraper);
    expect(called).toBe(1);
  });

  it("delegates auto-login strategy construction to the injected server factory", () => {
    const adapter = createPopularBankAdapter({
      createScraper: () => stubScraper,
      createAutoLoginStrategy: () => stubAutoLoginStrategy,
    });

    expect(adapter.createAutoLoginStrategy()).toBe(stubAutoLoginStrategy);
  });
});
