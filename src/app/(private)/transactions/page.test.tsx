import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TransactionsDashboard } from "./page";

describe("TransactionsDashboard", () => {
  it("shows filters and an empty state without bank portal controls", () => {
    const html = renderToStaticMarkup(<TransactionsDashboard filters={{}} transactions={[]} />);

    expect(html).toContain("Recent transactions");
    expect(html).toContain("Filter by bank");
    expect(html).toContain("Filter by amount");
    expect(html).toContain("No recent transactions are available");
    expect(html).not.toContain("MFA");
    expect(html).not.toContain("Scraper controls");
  });

  it("renders minimized transaction rows for employees", () => {
    const html = renderToStaticMarkup(
      <TransactionsDashboard
        filters={{ bankId: "popular", query: "factura" }}
        transactions={[
          {
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
          },
        ]}
      />,
    );

    expect(html).toContain("Banco: popular");
    expect(html).toContain("REF-123");
    expect(html).toContain("Cliente Uno");
    expect(html).toContain("DOP 1500.50");
    expect(html).not.toContain("sourceHash");
    expect(html).not.toContain("metadata");
  });
});
