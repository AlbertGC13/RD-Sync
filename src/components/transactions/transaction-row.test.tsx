import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TransactionRow } from "./transaction-row";
import type { DashboardTransaction } from "../../modules/transactions";

const baseTx: DashboardTransaction = {
  id: "tx-1",
  bankId: "popular",
  accountFingerprint: "acct-main",
  postedAt: "2026-06-07T13:45:00.000Z",
  amount: "1500.50",
  currency: "DOP",
  direction: "credit",
  reference: "REF-123",
  concept: "Pago factura 1001",
  originator: "Cliente Uno",
  reviewState: "new",
  reviewedAt: null,
};

describe("TransactionRow", () => {
  it("renders credit direction with the success badge variant", () => {
    const html = renderToStaticMarkup(
      <TransactionRow transaction={baseTx} reviewerMode={false} />,
    );
    expect(html).toContain("Crédito");
    expect(html).toContain("+");
    expect(html).toContain("DOP 1500.50");
  });

  it("renders debit direction with the warning badge variant", () => {
    const html = renderToStaticMarkup(
      <TransactionRow
        transaction={{ ...baseTx, direction: "debit", reference: "DEBIT-1" }}
        reviewerMode={false}
      />,
    );
    expect(html).toContain("Débito");
    expect(html).toContain("−");
  });

  it("never leaks source hash, balance, session, or MFA fields", () => {
    const html = renderToStaticMarkup(
      <TransactionRow transaction={baseTx} reviewerMode={false} />,
    );
    expect(html).not.toContain("sourceHash");
    expect(html).not.toContain("balance");
    expect(html).not.toContain("session");
    expect(html).not.toContain("MFA");
    expect(html).not.toContain("credentials");
  });

  it("shows the bank name in a human-readable form (not the raw id)", () => {
    const html = renderToStaticMarkup(
      <TransactionRow transaction={baseTx} reviewerMode={false} />,
    );
    expect(html).toContain("Banco Popular");
  });
});

describe("TransactionRow — es-DO + America/Santo_Domingo posted-at formatting", () => {
  it("formats the visible time using es-DO + America/Santo_Domingo, not en-US/UTC", () => {
    // 2026-06-07T13:45:00Z → 09:45 in Santo Domingo (UTC-4, no DST).
    const html = renderToStaticMarkup(
      <TransactionRow transaction={baseTx} reviewerMode={false} />,
    );

    // Spanish locale + 24h numeric time + day-month-year Santo Domingo.
    expect(html).toContain("09:45");
    // The English default would emit "1:45 PM" / "Jun 7" — must not appear.
    expect(html).not.toContain("1:45 PM");
    expect(html).not.toContain("Jun 7");
    expect(html).not.toContain("Jun");
  });
});
