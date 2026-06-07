import { describe, expect, it } from "vitest";

import {
  createReadOnlyBankScraper,
  redactDiagnosticText,
  type BankTransactionRow,
  type ReadOnlyScraperProfile,
} from "./index";

const profile: ReadOnlyScraperProfile = {
  bankId: "popular",
  accountFingerprint: "acct-main",
  transactionRowSelector: "#transactions tbody tr",
  mfaIndicatorSelector: "#otp",
  columnMap: {
    postedAt: "date",
    amount: "amount",
    currency: "currency",
    direction: "direction",
    reference: "reference",
    concept: "concept",
    originator: "originator",
  },
};

describe("read-only bank scraper", () => {
  it("collects transaction rows through read-only page access", async () => {
    const rows: BankTransactionRow[] = [
      {
        date: "2026-06-07T13:45:00.000Z",
        amount: "1,500.50",
        currency: "dop",
        direction: "credit",
        reference: "REF-123",
        concept: "Factura 904",
        originator: "Cliente Uno",
      },
      {
        date: "2026-06-07T14:00:00.000Z",
        amount: "750",
        currency: "DOP",
        direction: "debit",
        reference: "",
        concept: "Comision bancaria",
      },
    ];
    const page = new FakeReadOnlyPage({ rows });
    const scraper = createReadOnlyBankScraper(profile);

    const result = await scraper.collect(page);

    expect(result.status).toBe("collected");
    expect(result.movements).toEqual([
      {
        bankId: "popular",
        accountFingerprint: "acct-main",
        postedAt: "2026-06-07T13:45:00.000Z",
        amount: "1,500.50",
        currency: "DOP",
        direction: "credit",
        reference: "REF-123",
        concept: "Factura 904",
        originator: "Cliente Uno",
      },
      {
        bankId: "popular",
        accountFingerprint: "acct-main",
        postedAt: "2026-06-07T14:00:00.000Z",
        amount: "750",
        currency: "DOP",
        direction: "debit",
        reference: null,
        concept: "Comision bancaria",
        originator: null,
      },
    ]);
    expect(page.operations).toEqual([
      "isVisible:#otp",
      "evaluateRows:#transactions tbody tr",
    ]);
  });

  it("pauses collection safely when MFA is visible", async () => {
    const page = new FakeReadOnlyPage({
      mfaVisible: true,
      rows: [],
      diagnosticText: "OTP required token=secret-cookie account 12345678901",
    });
    const scraper = createReadOnlyBankScraper(profile);

    const result = await scraper.collect(page);

    expect(result.status).toBe("needs_admin_action");
    expect(result.movements).toEqual([]);
    expect(result.safeErrorSummary).toBe("Bank session requires admin MFA action. Diagnostic: OTP required [REDACTED] account [REDACTED_ACCOUNT]");
    expect(page.operations).toEqual(["isVisible:#otp", "diagnosticText"]);
  });

  it("rejects unsafe bank mutation selectors before a session is used", () => {
    expect(() =>
      createReadOnlyBankScraper({
        ...profile,
        transactionRowSelector: "#transfer-form tbody tr",
      }),
    ).toThrow("Unsafe bank mutation selector is not allowed");
  });
});

describe("scraper diagnostics redaction", () => {
  it("removes credentials, tokens, cookies, and long account numbers", () => {
    const redacted = redactDiagnosticText(
      "password=abc123 sessionToken=xyz cookie=bank.sid raw account 0012345678901 balance 99,999.00",
    );

    expect(redacted).toBe(
      "[REDACTED] [REDACTED] [REDACTED] raw account [REDACTED_ACCOUNT] balance [REDACTED_AMOUNT]",
    );
  });
});

class FakeReadOnlyPage {
  readonly operations: string[] = [];

  constructor(
    private readonly state: {
      rows: BankTransactionRow[];
      mfaVisible?: boolean;
      diagnosticText?: string;
    },
  ) {}

  async isVisible(selector: string): Promise<boolean> {
    this.operations.push(`isVisible:${selector}`);
    return this.state.mfaVisible ?? false;
  }

  async readRows(selector: string): Promise<BankTransactionRow[]> {
    this.operations.push(`evaluateRows:${selector}`);
    return this.state.rows;
  }

  async diagnosticText(): Promise<string> {
    this.operations.push("diagnosticText");
    return this.state.diagnosticText ?? "";
  }
}
