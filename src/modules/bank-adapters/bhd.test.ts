import { describe, expect, it } from "vitest";
import {
  bhdPersonalAdapter, bhdPersonalScraperProfile,
  bhdPersonalPortalConfig, bhdBankCode,
  parseBhdDate, parseBhdAmount, parseBhdTransactionRows,
} from "./bhd";
import { bhdPersonalTransactions } from "./fixtures/bhd-personal";

describe("BHD Personal adapter identity + skeleton contract", () => {
  it("bankCode=bhd, portalVariant=personal, auto-login not implemented", () => {
    expect(bhdBankCode).toBe("bhd");
    expect(bhdPersonalAdapter.bankCode).toBe("bhd");
    expect(bhdPersonalAdapter.portalVariant).toBe("personal");
    expect(() => bhdPersonalAdapter.createAutoLoginStrategy()).toThrow(/not implemented/i);
  });

  it("stub scraper returns needs_admin_action with exact safeErrorSummary", async () => {
    const r = await bhdPersonalAdapter.createScraper().collect();
    expect(r.status).toBe("needs_admin_action");
    expect(r.movements).toEqual([]);
    expect(r.safeErrorSummary).toBe("BHD Personal adapter is a skeleton");
  });

  it("stub session checker returns expired (fail-safe) with exact safeSummary", async () => {
    const r = await bhdPersonalAdapter.createSessionChecker().check();
    expect(r.status).toBe("expired");
    expect(r.safeSummary).toBe("Bank session expired or requires verification");
  });
});

describe("BHD Personal profile — recon-derived fields", () => {
  it("identity, login, accountFingerprint, loginStrategy, routes", () => {
    expect(bhdPersonalScraperProfile.bankId).toBe("bhd");
    expect(bhdPersonalScraperProfile.portalVariant).toBe("personal");
    expect(bhdPersonalScraperProfile.loginUrl).toBe("https://ibp.bhd.com.do/#/login");
    expect(bhdPersonalScraperProfile.accountFingerprint).toBe("bhd-XXXXXXXXXX");
    expect(bhdPersonalScraperProfile.loginStrategy).toBe("admin-assisted-first-login+remember-browser+cdp-attach");
    expect(bhdPersonalScraperProfile.routes).toEqual({
      dashboard: "#/bhd/dashboard", productDetail: "#/bhd/product-detail",
    });
  });

  it("login selectors, CAPTCHA area, date inputs, transaction table + row + column mapping", () => {
    expect(bhdPersonalScraperProfile.selectors).toMatchObject({
      usernameInput: "input#userName", passwordInput: "input#password",
      captchaArea: "div.field.col-10.mb-2", submitButton: "button[type='submit'].bhd-btn-primary",
      accountCard: "app-account-card", viewMovementsButton: "button.bhd-btn-primary",
      periodDropdown: "div.p-select-dropdown", searchInput: "input[placeholder='Buscar']",
      fromDateInput: "input.p-datepicker-input[placeholder='Fecha inicio']",
      toDateInput: "input.p-datepicker-input[placeholder='Fecha final']",
      transactionTable: "table.p-datatable-table", transactionRow: "tr.body-responsive",
    });
    expect(bhdPersonalScraperProfile.columnMapping).toEqual({
      date: 0, confirmation: 1, description: 2, receipt: 3, debit: 4, credit: 5, balance: 6,
    });
    expect(bhdPersonalScraperProfile.formats).toEqual({ date: "DD/MM/YYYY", amount: "RD$ 1,234.56" });
    expect(bhdPersonalScraperProfile.paginationStrategy).toBe("scroll-stabilize");
  });
});

describe("BHD portal config", () => {
  it("bankCode, baseUrl, CDP env, login allowlist", () => {
    expect(bhdPersonalPortalConfig.bankCode).toBe("bhd");
    expect(bhdPersonalPortalConfig.baseUrl).toBe("https://ibp.bhd.com.do");
    expect(bhdPersonalPortalConfig.loginPathAllowlist).toContain("/#/login");
    expect(bhdPersonalPortalConfig.cdpUrlEnv).toBe("RD_SYNC_BANK_BHD_CDP_URL");
  });
});

// ---------------------------------------------------------------------------
// parseBhdDate — DD/MM/YYYY → ISO 8601 with Santo Domingo offset
// ---------------------------------------------------------------------------

describe("parseBhdDate", () => {
  it("parses DD/MM/YYYY to ISO 8601 with -04:00 offset", () => {
    expect(parseBhdDate("27/06/2026")).toBe("2026-06-27T00:00:00-04:00");
  });

  it("parses zero-padded day and month", () => {
    expect(parseBhdDate("01/01/2025")).toBe("2025-01-01T00:00:00-04:00");
  });

  it("parses 31/12/2024 year boundary", () => {
    expect(parseBhdDate("31/12/2024")).toBe("2024-12-31T00:00:00-04:00");
  });

  it("throws on non-DD/MM/YYYY format", () => {
    expect(() => parseBhdDate("2026-06-27")).toThrow("Invalid BHD date format");
  });

  it("throws on short year", () => {
    expect(() => parseBhdDate("27/06/26")).toThrow("Invalid BHD date format");
  });

  it("throws on empty string", () => {
    expect(() => parseBhdDate("")).toThrow("Invalid BHD date format");
  });

  it("throws on impossible month 13", () => {
    expect(() => parseBhdDate("27/13/2026")).toThrow("Invalid BHD date format");
  });

  it("throws on impossible day 32", () => {
    expect(() => parseBhdDate("32/06/2026")).toThrow("Invalid BHD date format");
  });

  it("throws on day 31 for 30-day month (April)", () => {
    expect(() => parseBhdDate("31/04/2026")).toThrow("Invalid BHD date format");
  });

  it("throws on Feb 30", () => {
    expect(() => parseBhdDate("30/02/2026")).toThrow("Invalid BHD date format");
  });

  it("throws on Feb 29 in non-leap year", () => {
    expect(() => parseBhdDate("29/02/2025")).toThrow("Invalid BHD date format");
  });

  it("accepts Feb 29 in leap year 2024", () => {
    expect(parseBhdDate("29/02/2024")).toBe("2024-02-29T00:00:00-04:00");
  });
});

// ---------------------------------------------------------------------------
// parseBhdAmount — "RD$ 1,234.56" → { value, direction }
// ---------------------------------------------------------------------------

describe("parseBhdAmount", () => {
  it("parses positive RD$ credit amount", () => {
    const r = parseBhdAmount("RD$ 15,000.00");
    expect(r.value).toBe(15000);
    expect(r.direction).toBe("credit");
  });

  it("parses debit amount from the debit column", () => {
    const r = parseBhdAmount("RD$ 679.51");
    expect(r.value).toBeCloseTo(679.51);
    // Direction is determined by column context, not the amount string.
    // parseBhdAmount returns credit for positive; the row parser maps debit column → debit.
    expect(r.direction).toBe("credit");
  });

  it("parses zero amount as credit", () => {
    const r = parseBhdAmount("RD$ 0.00");
    expect(r.value).toBe(0);
    expect(r.direction).toBe("credit");
  });

  it("throws on malformed amount", () => {
    expect(() => parseBhdAmount("RD$ --")).toThrow("Invalid BHD amount format");
  });

  it("throws on empty string", () => {
    expect(() => parseBhdAmount("")).toThrow("Invalid BHD amount format");
  });
});

// ---------------------------------------------------------------------------
// parseBhdTransactionRows — BhdPersonalTransaction[] → BankMovement[]
// ---------------------------------------------------------------------------

describe("parseBhdTransactionRows", () => {
  it("parses fixture transactions into BankMovement objects", () => {
    const movements = parseBhdTransactionRows(bhdPersonalTransactions);

    expect(movements).toHaveLength(2);

    expect(movements[0]).toMatchObject({
      bankId: "bhd",
      accountFingerprint: "bhd-XXXXXXXXXX",
      postedAt: "2026-06-27T00:00:00-04:00",
      amount: "15000.00",
      currency: "DOP",
      direction: "credit",
      concept: "DEPOSITO EN EFECTIVO",
    });
    expect(movements[0].reference).toBe("2638001");

    expect(movements[1]).toMatchObject({
      bankId: "bhd",
      accountFingerprint: "bhd-XXXXXXXXXX",
      postedAt: "2026-06-27T00:00:00-04:00",
      amount: "679.51",
      currency: "DOP",
      direction: "debit",
      concept: "Fondo reservado Visa Db: 20260627",
    });
    expect(movements[1].reference).toBe("2638002");
  });

  it("returns empty array for empty input", () => {
    expect(parseBhdTransactionRows([])).toEqual([]);
  });

  it("includes confirmation number as reference", () => {
    const movements = parseBhdTransactionRows(bhdPersonalTransactions);
    for (const m of movements) {
      expect(typeof m.reference).toBe("string");
      expect(m.reference!.length).toBeGreaterThan(0);
    }
  });

  it("does not include balance in the output movement", () => {
    const movements = parseBhdTransactionRows(bhdPersonalTransactions);
    for (const m of movements) {
      expect(JSON.stringify(m)).not.toContain("balance");
    }
  });

  it("accepts custom bankId and accountFingerprint overrides", () => {
    const movements = parseBhdTransactionRows(bhdPersonalTransactions, {
      bankId: "bhd-custom",
      accountFingerprint: "bhd-custom-fp",
    });
    expect(movements[0].bankId).toBe("bhd-custom");
    expect(movements[0].accountFingerprint).toBe("bhd-custom-fp");
  });

  it("rejects malformed dates in transaction rows", () => {
    expect(() =>
      parseBhdTransactionRows([
        { ...bhdPersonalTransactions[0], date: "2026-06-27" },
      ]),
    ).toThrow("Invalid BHD date format");
  });

  it("rejects malformed amounts in transaction rows", () => {
    expect(() =>
      parseBhdTransactionRows([
        { ...bhdPersonalTransactions[0], debit: "RD$ --", credit: "" },
      ]),
    ).toThrow("Invalid BHD amount format");
  });

  it("rejects row where both debit and credit are populated", () => {
    expect(() =>
      parseBhdTransactionRows([
        {
          ...bhdPersonalTransactions[0],
          debit: "RD$ 100.00",
          credit: "RD$ 200.00",
        },
      ]),
    ).toThrow("ambiguous");
  });

  it("rejects row where both debit and credit are empty", () => {
    expect(() =>
      parseBhdTransactionRows([
        {
          ...bhdPersonalTransactions[0],
          debit: "",
          credit: "",
        },
      ]),
    ).toThrow("missing");
  });

  it("normalizes whitespace-only confirmationNumber to null", () => {
    const movements = parseBhdTransactionRows([
      {
        ...bhdPersonalTransactions[0],
        confirmationNumber: "   ",
      },
    ]);
    expect(movements[0].reference).toBeNull();
  });

  it("trims whitespace from confirmationNumber", () => {
    const movements = parseBhdTransactionRows([
      {
        ...bhdPersonalTransactions[0],
        confirmationNumber: " 2638001 ",
      },
    ]);
    expect(movements[0].reference).toBe("2638001");
  });

  it("normalizes whitespace-only receipt to null in metadata", () => {
    const movements = parseBhdTransactionRows([
      {
        ...bhdPersonalTransactions[0],
        receipt: "   ",
      },
    ]);
    expect(movements[0].metadata!.receipt).toBeNull();
  });

  it("trims whitespace from receipt", () => {
    const movements = parseBhdTransactionRows([
      {
        ...bhdPersonalTransactions[0],
        receipt: " 0000000000 ",
      },
    ]);
    expect(movements[0].metadata!.receipt).toBe("0000000000");
  });
});
