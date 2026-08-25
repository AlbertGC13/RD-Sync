import { describe, expect, it } from "vitest";
import {
  bhdPersonalBankCode,
  bhdPersonalPortalProfile,
  parseBhdAmount,
  parseBhdDate,
  parseBhdTransactionRows,
} from "./bhd";
import { bhdPersonalTransactions } from "./fixtures/bhd-personal";

describe("BHD Personal profile", () => {
  it("exposes the canonical code, Personal variant, stable PrimeNG selectors, and row positions", () => {
    expect(bhdPersonalBankCode).toBe("bhd_personal");
    expect(bhdPersonalPortalProfile).toMatchObject({
      bankCode: "bhd_personal",
      portalVariant: "personal",
      sessionAccess: "admin-assisted-cdp-attach",
      selectors: {
        transactionTable: "table.p-datatable-table",
        transactionRow: "tr.body-responsive",
        fromDateInput: "input[placeholder='Fecha inicio']",
        toDateInput: "input[placeholder='Fecha final']",
      },
      columnMapping: { date: 0, confirmation: 1, description: 2, receipt: 3, debit: 4, credit: 5, balance: 6 },
    });
    expect(JSON.stringify(bhdPersonalPortalProfile)).not.toContain("ng-tns-");
  });
});

describe("BHD Personal parser", () => {
  it("parses sanitized credit and debit rows with Dominican midnight semantics", () => {
    expect(parseBhdTransactionRows(bhdPersonalTransactions)).toEqual([
      expect.objectContaining({
        bankId: "bhd_personal", accountFingerprint: "bhd_personal-XXXXXXXXXX",
        postedAt: "2026-06-27T00:00:00-04:00", amount: "15000.00", direction: "credit", reference: "2638001",
      }),
      expect.objectContaining({
        postedAt: "2026-06-27T00:00:00-04:00", amount: "679.51", direction: "debit", reference: "2638002",
      }),
    ]);
  });

  it("validates DD/MM/YYYY dates including impossible and leap dates", () => {
    expect(parseBhdDate("29/02/2024")).toBe("2024-02-29T00:00:00-04:00");
    for (const value of ["2026-06-27", "31/04/2026", "29/02/2025"]) {
      expect(() => parseBhdDate(value)).toThrow("Invalid BHD date format");
    }
  });

  it("normalizes absolute two-decimal Dominican amounts", () => {
    expect(parseBhdAmount(" RD$ -1,234.5 ")).toBe(-1234.5);
    expect(parseBhdTransactionRows([{ ...bhdPersonalTransactions[0], credit: "RD$ -1,234.5" }])[0].amount).toBe("1234.50");
    expect(() => parseBhdAmount("RD$ --")).toThrow("Invalid BHD amount format");
  });

  it("requires exactly one populated debit or credit column", () => {
    expect(() => parseBhdTransactionRows([{ ...bhdPersonalTransactions[0], debit: "RD$ 1.00" }])).toThrow("exactly one");
    expect(() => parseBhdTransactionRows([{ ...bhdPersonalTransactions[0], debit: "", credit: "" }])).toThrow("exactly one");
  });

  it("normalizes text metadata, supports overrides, and never persists the running balance", () => {
    const [movement] = parseBhdTransactionRows([{
      ...bhdPersonalTransactions[0], confirmationNumber: "  REF-1  ", receipt: "  R-1  ", description: "  Cash   deposit  ",
    }], { bankId: "bank-override", accountFingerprint: "fingerprint-override", currency: "USD" });
    expect(movement).toMatchObject({
      bankId: "bank-override", accountFingerprint: "fingerprint-override", currency: "USD", reference: "REF-1", concept: "Cash deposit",
      metadata: { receipt: "R-1" },
    });
    expect(movement).not.toHaveProperty("balance");
    expect(JSON.stringify(movement)).not.toContain("22,167.94");
  });

  it("returns no movements for no rows without I/O or environment configuration", () => {
    expect(parseBhdTransactionRows([])).toEqual([]);
  });
});
