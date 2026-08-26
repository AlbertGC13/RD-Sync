import { describe, expect, it } from "vitest";
import { getBankPortalIdentity } from "./bank-identities";
import {
  banreservasEmpresasBankCode,
  banreservasEmpresasPortalProfile,
  parseBanreservasEmpresasAmount,
  parseBanreservasEmpresasDate,
  parseBanreservasEmpresasTransactionRows,
} from "./banreservas-empresas";
import { banreservasEmpresasTransactions } from "./fixtures/banreservas-empresas";

describe("Banreservas Empresas portal profile", () => {
  it("captures the separate Empresas WebForms main-frame DOM contract", () => {
    expect(banreservasEmpresasBankCode).toBe("banreservas_empresas");
    expect(getBankPortalIdentity("banreservas")).toBeUndefined();
    expect(banreservasEmpresasPortalProfile).toMatchObject({
      bankCode: "banreservas_empresas",
      portalVariant: "empresas",
      loginUrl: "https://www.banreservas.com.do/TuBancoEmpresas/Login.aspx",
      landingUrl: "https://www.banreservas.com.do/TuBancoEmpresas/Default.aspx",
      frames: { top: "topFrame", left: "leftFrame", main: "mainFrame", content: "mainFrame" },
      routes: { accounts: "/TuBancoEmpresas/Pages/Accounts/Accounts.aspx" },
      selectors: {
        dateFrom: "#ctl00_MainHolder_period_dateTextBoxDateFrom",
        dateTo: "#ctl00_MainHolder_period_dateTextBoxDateTo",
        query: "#ctl00_MainHolder_period_linkButtonConsultar",
        back: "#ctl00_MainHolder_linkButtonBackToFrom1",
        transactionGrid: "#ctl00_MainHolder_AccountTransactionGrid_ASPxGridViewTransactions",
        transactionRow: 'tr[id*="_DXDataRow"].dxgvDataRow',
      },
      columnMapping: { date: 0, transactionNumber: 1, concept: 2, debit: 3, credit: 4, balance: 5 },
      formats: { date: "DD/MM/YY", timezoneOffset: "-04:00" },
    });
  });
});

describe("parseBanreservasEmpresasDate", () => {
  it.each([
    ["01/01/00", "2000-01-01T00:00:00-04:00"],
    ["29/02/24", "2024-02-29T00:00:00-04:00"],
    ["31/12/99", "2099-12-31T00:00:00-04:00"],
  ])("parses %s using the deterministic 2000 + YY rule", (value, expected) => {
    expect(parseBanreservasEmpresasDate(value)).toBe(expected);
  });

  it.each(["1/01/00", "01/1/00", "01/01/0", "01/01/2000", " 01/01/00", "01/01/00 ", "00/01/00", "31/04/26", "29/02/25", "29/13/26"])
  ("rejects malformed or impossible date %j", (value) => {
    expect(() => parseBanreservasEmpresasDate(value)).toThrow("Invalid Banreservas Empresas date format");
  });
});

describe("parseBanreservasEmpresasAmount", () => {
  it.each([["0.00", 0], ["1234", 1234], ["1,234,567.89", 1234567.89]])("parses unsigned amount %s", (value, expected) => {
    expect(parseBanreservasEmpresasAmount(value)).toBe(expected);
  });

  it.each(["", " 1.00", "1.00 ", "DOP 1.00", "RD$ 1.00", "-1.00", "+1.00", "1,00.00", "1,234.567", "01,000.00", ".50", "1."])
  ("rejects invalid unsigned amount %j", (value) => {
    expect(() => parseBanreservasEmpresasAmount(value)).toThrow("Invalid Banreservas Empresas amount format");
  });
});

describe("parseBanreservasEmpresasTransactionRows", () => {
  it("maps fixture rows with canonical identity, normalized concept, and no balance leakage", () => {
    const movements = parseBanreservasEmpresasTransactionRows(banreservasEmpresasTransactions);
    expect(movements).toEqual([
      expect.objectContaining({ bankId: "banreservas_empresas", postedAt: "2026-06-29T00:00:00-04:00", amount: "1250.00", direction: "credit", reference: "TXN-EXAMPLE-001", concept: "PAYMENT RECEIVED", metadata: null }),
      expect.objectContaining({ bankId: "banreservas_empresas", postedAt: "2026-06-28T00:00:00-04:00", amount: "9.75", direction: "debit", reference: null, concept: "SERVICE CHARGE", metadata: null }),
    ]);
    expect(JSON.stringify(movements)).not.toContain("DOP 9,999.99");
  });

  it("uses the canonical identity even if an unsupported override is supplied at runtime", () => {
    const [movement] = parseBanreservasEmpresasTransactionRows(banreservasEmpresasTransactions, { bankId: "banreservas" } as never);
    expect(movement.bankId).toBe("banreservas_empresas");
  });

  it("trims transaction number, collapses description whitespace, and accepts inactive zero cells", () => {
    const [movement] = parseBanreservasEmpresasTransactionRows([{ date: "01/03/26", transactionNumber: "  TXN-9  ", concept: "  FEE\n  COLLECTION ", debit: "0.00", credit: "2.50", balance: "DOP 1.00" }]);
    expect(movement).toMatchObject({ reference: "TXN-9", concept: "FEE COLLECTION", direction: "credit", amount: "2.50" });
  });

  it.each([
    [{ debit: "0.00", credit: "0.00" }, "missing"],
    [{ debit: "1.00", credit: "2.00" }, "ambiguous"],
    [{ debit: "0,00.00", credit: "2.00" }, "Invalid Banreservas Empresas amount format"],
    [{ debit: "1.00", credit: "DOP 0.00" }, "Invalid Banreservas Empresas amount format"],
  ])("rejects invalid debit-credit pair %#", (amounts, message) => {
    expect(() => parseBanreservasEmpresasTransactionRows([{ ...banreservasEmpresasTransactions[0], ...amounts }])).toThrow(message);
  });

  it("returns no movement for no DOM rows", () => {
    expect(parseBanreservasEmpresasTransactionRows([])).toEqual([]);
  });
});

describe("banreservasEmpresasTransactions fixture", () => {
  it("contains only sanitized synthetic portal values", () => {
    expect(banreservasEmpresasTransactions).toEqual([
      { date: "29/06/26", transactionNumber: "TXN-EXAMPLE-001", concept: "PAYMENT RECEIVED", debit: "0.00", credit: "1,250.00", balance: "DOP 9,999.99" },
      { date: "28/06/26", transactionNumber: "   ", concept: "SERVICE CHARGE", debit: "9.75", credit: "0.00", balance: "DOP 9,990.24" },
    ]);
  });
});
