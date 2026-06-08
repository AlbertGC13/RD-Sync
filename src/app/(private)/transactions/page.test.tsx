import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/transactions",
}));

import { TransactionsDashboard } from "./page";
import type { DashboardTransaction } from "../../../modules/transactions";

const sampleTransactions: DashboardTransaction[] = [
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
];

describe("TransactionsDashboard", () => {
  it("shows the heading and an empty state without bank portal controls", () => {
    const html = renderToStaticMarkup(
      <TransactionsDashboard filters={{}} transactions={[]} reviewerMode={false} />,
    );

    // Strings that the E2E suite asserts on (REQ-DS-004 contract):
    expect(html).toContain("Recent transactions");
    expect(html).toContain("Filter transactions");
    expect(html).toContain("No recent transactions are available");
    // Negative guarantees: no admin-only signals leak to the employee view.
    expect(html).not.toContain("MFA");
    expect(html).not.toContain("Scraper controls");
  });

  it("renders minimized transaction rows for employees with credit indicator", () => {
    const html = renderToStaticMarkup(
      <TransactionsDashboard
        filters={{ bankId: "popular", query: "factura" }}
        transactions={sampleTransactions}
        reviewerMode={false}
      />,
    );

    // Per-row visual contract (REQ-TX-UX-003):
    expect(html).toContain("Banco Popular");
    expect(html).toContain("REF-123");
    expect(html).toContain("Cliente Uno");
    expect(html).toContain("DOP 1500.50");
    expect(html).toContain("Credit");
    // Data minimization: source hash and metadata MUST NOT appear.
    expect(html).not.toContain("sourceHash");
    expect(html).not.toContain("metadata");
  });

  it("renders a debit indicator for debit transactions", () => {
    const html = renderToStaticMarkup(
      <TransactionsDashboard
        filters={{}}
        transactions={[
          {
            ...sampleTransactions[0],
            id: "tx-2",
            direction: "debit",
            reference: "REF-DEBIT",
          },
        ]}
        reviewerMode={false}
      />,
    );

    expect(html).toContain("Debit");
    expect(html).toContain("REF-DEBIT");
  });

  it("does not surface review action buttons for viewers", () => {
    const html = renderToStaticMarkup(
      <TransactionsDashboard
        filters={{}}
        transactions={sampleTransactions}
        reviewerMode={false}
      />,
    );

    expect(html).not.toContain("Review actions");
    expect(html).not.toContain("internally validated");
  });

  it("exposes the full FR-010 filter set", () => {
    const html = renderToStaticMarkup(
      <TransactionsDashboard
        filters={{
          bankId: "popular",
          amount: "1500",
          query: "REF-1",
          currency: "DOP",
          accountFingerprint: "acct-main",
          dateFrom: "2026-06-01",
          dateTo: "2026-06-30",
          reviewState: "new",
        }}
        transactions={[]}
        reviewerMode={false}
      />,
    );

    expect(html).toContain('id="filter-bankId"');
    expect(html).toContain('id="filter-amount"');
    expect(html).toContain('id="filter-query"');
    expect(html).toContain('id="filter-currency"');
    expect(html).toContain('id="filter-accountFingerprint"');
    expect(html).toContain('id="filter-dateFrom"');
    expect(html).toContain('id="filter-dateTo"');
    expect(html).toContain('id="filter-reviewState"');
  });
});
