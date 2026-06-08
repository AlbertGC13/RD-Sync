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
    expect(html).toContain("Credit");
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
    expect(html).toContain("Debit");
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
