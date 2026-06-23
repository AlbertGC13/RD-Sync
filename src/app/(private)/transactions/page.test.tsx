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

const baseTransaction: DashboardTransaction = {
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

const sampleTransactions: DashboardTransaction[] = [baseTransaction];

describe("TransactionsDashboard", () => {
  it("renders the Spanish heading, empty-state copy, and filter labels without leaking admin strings", () => {
    const html = renderToStaticMarkup(
      <TransactionsDashboard filters={{}} transactions={[]} reviewerMode={false} />,
    );

    // Strings the E2E suite and the visual contract depend on, in Spanish.
    expect(html).toContain("Transacciones recientes");
    expect(html).toContain('aria-label="Filtros de transacciones"');
    expect(html).toContain("No hay transacciones recientes disponibles");
    // Negative guarantees: no admin-only signals leak to the employee view.
    expect(html).not.toContain("MFA");
    expect(html).not.toContain("Scraper controls");
  });

  it("renders minimized transaction rows for employees with the Spanish credit indicator", () => {
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
    expect(html).toContain("DOP 1,500.50");
    expect(html).toContain("Crédito");
    // Data minimization: source hash and metadata MUST NOT appear.
    expect(html).not.toContain("sourceHash");
    expect(html).not.toContain("metadata");
  });

  it("renders a debit indicator in Spanish for debit transactions", () => {
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

    expect(html).toContain("Débito");
    expect(html).toContain("REF-DEBIT");
  });

  it("does not surface review action buttons to viewers", () => {
    const html = renderToStaticMarkup(
      <TransactionsDashboard
        filters={{}}
        transactions={sampleTransactions}
        reviewerMode={false}
      />,
    );

    // The reviewer affordance group must NOT render in employee view.
    expect(html).not.toContain("Acciones de revisión");
    // Spanish review-state labels must not appear when reviewer mode is off.
    expect(html).not.toContain("Validada internamente");
  });

  it("exposes the full FR-010 filter set with Spanish field labels", () => {
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

    // Field identifiers must still be present so the E2E suite can target them.
    expect(html).toContain('id="filter-bankId"');
    expect(html).toContain('id="filter-amount"');
    expect(html).toContain('id="filter-query"');
    expect(html).toContain('id="filter-currency"');
    expect(html).toContain('id="filter-accountFingerprint"');
    expect(html).toContain('id="filter-dateFrom"');
    expect(html).toContain('id="filter-dateTo"');
    expect(html).toContain('id="filter-reviewState"');
    // Visible Spanish labels.
    expect(html).toContain("Banco");
    expect(html).toContain("Monto");
    expect(html).toContain("Moneda");
    expect(html).toContain("Identificador de cuenta");
    expect(html).toContain("Desde");
    expect(html).toContain("Hasta");
    expect(html).toContain("Estado de revisión");
    expect(html).toContain("Aplicar filtros");
  });

  it("passes reviewerMode down to rows so reviewer affordances render with Spanish labels", () => {
    const html = renderToStaticMarkup(
      <TransactionsDashboard
        filters={{}}
        transactions={sampleTransactions}
        reviewerMode={true}
      />,
    );

    // Reviewer pill (Spanish) is rendered in each row.
    expect(html).toContain("Nueva");
    // Review actions affordance group label is localized.
    expect(html).toContain("Acciones de revisión (próximamente)");
    // Button labels are the Spanish state names — not raw enum values.
    expect(html).toContain("Validada internamente");
    expect(html).toContain("Pendiente de revisión");
  });

  it("keeps reviewer affordances hidden when reviewerMode is false", () => {
    const html = renderToStaticMarkup(
      <TransactionsDashboard
        filters={{}}
        transactions={sampleTransactions}
        reviewerMode={false}
      />,
    );

    // Employee view MUST NOT surface reviewer actions.
    expect(html).not.toContain("Acciones de revisión");
    expect(html).not.toContain("Validada internamente");
    expect(html).not.toContain("Pendiente de revisión");
  });
});

describe("TransactionsDashboard — Santo Domingo banking-day grouping", () => {
  it("groups transactions by the Santo Domingo banking day, not the UTC day", () => {
    // Two transactions that share the same UTC day but land on DIFFERENT
    // Santo Domingo banking days. Grouping by UTC (the previous behaviour)
    // would collapse them under one header; grouping by the local day
    // (the fixed behaviour) must produce two distinct headers.
    const sundayNight: DashboardTransaction = {
      ...baseTransaction,
      id: "tx-sunday-night",
      postedAt: "2026-06-07T03:30:00.000Z", // 23:30 Saturday in Santo Domingo
    };
    const mondayMorning: DashboardTransaction = {
      ...baseTransaction,
      id: "tx-monday-morning",
      postedAt: "2026-06-07T05:30:00.000Z", // 01:30 Sunday in Santo Domingo
    };

    const html = renderToStaticMarkup(
      <TransactionsDashboard
        filters={{}}
        transactions={[sundayNight, mondayMorning]}
        reviewerMode={false}
      />,
    );

    // Both localized day headers appear, one per Santo Domingo day.
    expect(html).toContain("sáb, 6 jun 2026"); // Saturday June 6 (the night transaction)
    expect(html).toContain("dom, 7 jun 2026"); // Sunday June 7 (the morning transaction)

    // Each transaction is rendered under the correct bucket (visible
    // reference / concept label belongs to its own row).
    expect(html).toContain("REF-123"); // each row carries the same reference
  });

  it("uses es-DO + America/Santo_Domingo for the visible date header", () => {
    const html = renderToStaticMarkup(
      <TransactionsDashboard
        filters={{}}
        transactions={sampleTransactions}
        reviewerMode={false}
      />,
    );

    // The single transaction at 2026-06-07T13:45Z → Santo Domingo day
    // 2026-06-07, formatted with the es-DO locale (no UTC and no en-US).
    expect(html).toContain("dom, 7 jun 2026");
    expect(html).not.toContain("Jun 7, 2026");
    expect(html).not.toContain("2026-06-07");
  });
});
