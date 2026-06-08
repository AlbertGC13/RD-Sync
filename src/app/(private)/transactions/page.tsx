import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";

import { listTransactionsForPage } from "../../api/transactions/defaults";
import { canReviewTransactions, resolvePrincipalFromTrustedHeaders } from "../../../modules/auth";
import {
  type DashboardTransaction,
  type TransactionFilters,
  type TransactionDirection,
} from "../../../modules/transactions";
import { TransactionRow } from "../../../components/transactions/transaction-row";
import { ReviewActions } from "../../../components/transactions/review-actions";
import { EmptyState } from "../../../components/ui/empty-state";
import { PageHeader } from "../../../components/ui/page-header";

export const metadata: Metadata = {
  title: "Recent transactions · RD-Sync",
  description: "Employee-safe visibility into normalized bank movements.",
};

interface TransactionsPageProps {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

export default async function TransactionsPage({ searchParams }: TransactionsPageProps) {
  const resolvedSearchParams = searchParams ? await searchParams : {};
  const filters = toTransactionFilters(resolvedSearchParams);
  const transactions = await listTransactionsForPage(filters);

  // Authorization happens at the trusted-header level. The (private) layout
  // already gates the route, so here we only decide whether to surface
  // reviewer affordances (FR-011) for the current principal.
  const principal = resolvePrincipalFromTrustedHeaders(await headers());
  const reviewerMode = canReviewTransactions(principal);

  return (
    <TransactionsDashboard
      filters={filters}
      transactions={transactions}
      reviewerMode={reviewerMode}
    />
  );
}

interface TransactionsDashboardProps {
  filters: TransactionFilters;
  transactions: DashboardTransaction[];
  reviewerMode: boolean;
}

export function TransactionsDashboard({
  filters,
  transactions,
  reviewerMode,
}: TransactionsDashboardProps) {
  const hasActiveFilters = isAnyFilterActive(filters);

  return (
    <main className="mx-auto grid min-h-screen max-w-6xl gap-6 px-6 py-12">
      <PageHeader
        eyebrow="RD-Sync"
        title="Recent transactions"
        description="Employee-safe visibility into normalized bank movements. Bank sessions, credentials, and operational controls are intentionally excluded from this screen."
      />

      <form
        method="get"
        className="grid gap-4 rounded-lg border border-border bg-card p-4 sm:grid-cols-[repeat(auto-fit,minmax(14rem,1fr))]"
        aria-label="Transaction filters"
      >
        <label className="grid gap-2 text-sm text-card-foreground">
          Filter by bank
          <input
            name="bankId"
            defaultValue={filters.bankId}
            placeholder="popular, bhd, banreservas"
            className="min-h-11 rounded-md border border-input bg-background px-4 py-3 font-sans text-foreground"
          />
        </label>
        <label className="grid gap-2 text-sm text-card-foreground">
          Filter by amount
          <input
            name="amount"
            defaultValue={filters.amount?.toString()}
            inputMode="decimal"
            placeholder="1500.50"
            className="min-h-11 rounded-md border border-input bg-background px-4 py-3 font-sans text-foreground"
          />
        </label>
        <label className="grid gap-2 text-sm text-card-foreground">
          Filter by reference or concept
          <input
            name="query"
            defaultValue={filters.query}
            placeholder="Reference, concept, originator"
            className="min-h-11 rounded-md border border-input bg-background px-4 py-3 font-sans text-foreground"
          />
        </label>
        <label className="grid gap-2 text-sm text-card-foreground">
          Currency
          <input
            name="currency"
            defaultValue={filters.currency}
            placeholder="DOP, USD"
            className="min-h-11 rounded-md border border-input bg-background px-4 py-3 font-sans text-foreground"
          />
        </label>
        <label className="grid gap-2 text-sm text-card-foreground">
          Account fingerprint
          <input
            name="accountFingerprint"
            defaultValue={filters.accountFingerprint}
            placeholder="acct-main"
            className="min-h-11 rounded-md border border-input bg-background px-4 py-3 font-sans text-foreground"
          />
        </label>
        <label className="grid gap-2 text-sm text-card-foreground">
          From (date)
          <input
            type="date"
            name="dateFrom"
            defaultValue={toDateInputValue(filters.dateFrom)}
            className="min-h-11 rounded-md border border-input bg-background px-4 py-3 font-sans text-foreground"
          />
        </label>
        <label className="grid gap-2 text-sm text-card-foreground">
          To (date)
          <input
            type="date"
            name="dateTo"
            defaultValue={toDateInputValue(filters.dateTo)}
            className="min-h-11 rounded-md border border-input bg-background px-4 py-3 font-sans text-foreground"
          />
        </label>
        <button
          type="submit"
          className="min-h-11 cursor-pointer self-end rounded-md bg-accent px-4 py-3 font-bold text-accent-foreground"
        >
          Apply filters
        </button>
      </form>

      {transactions.length === 0 ? (
        <EmptyState
          title="No recent transactions are available"
          description={
            hasActiveFilters
              ? "No transactions match the current filters. Clear the filters above to see all recent movements."
              : "Transactions will appear here after ingestion stores normalized bank movements."
          }
          action={
            hasActiveFilters ? (
              <Link
                href="/transactions"
                className="inline-flex min-h-11 items-center rounded-md border border-border bg-background px-4 py-3 text-sm font-medium text-foreground hover:bg-accent hover:text-accent-foreground"
              >
                Clear filters
              </Link>
            ) : undefined
          }
        />
      ) : (
        <section aria-label="Transaction results" className="grid gap-4">
          {transactions.map((transaction) => (
            <TransactionRow
              key={transaction.id}
              transaction={transaction}
              actions={
                reviewerMode ? (
                  <ReviewActions transactionId={transaction.id} currentState={transaction.reviewState} />
                ) : null
              }
            />
          ))}
        </section>
      )}
    </main>
  );
}

function toTransactionFilters(
  searchParams: Record<string, string | string[] | undefined>,
): TransactionFilters {
  return {
    bankId: firstValue(searchParams.bankId),
    amount: firstValue(searchParams.amount),
    query: firstValue(searchParams.query),
    currency: firstValue(searchParams.currency)?.toUpperCase(),
    accountFingerprint: firstValue(searchParams.accountFingerprint),
    dateFrom: firstValue(searchParams.dateFrom),
    dateTo: firstValue(searchParams.dateTo),
    reviewState: firstValue(searchParams.reviewState) as TransactionFilters["reviewState"],
  };
}

function firstValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function isAnyFilterActive(filters: TransactionFilters): boolean {
  return Boolean(
    filters.bankId ||
      filters.amount ||
      filters.query ||
      filters.currency ||
      filters.accountFingerprint ||
      filters.dateFrom ||
      filters.dateTo ||
      filters.reviewState,
  );
}

function toDateInputValue(value: string | Date | undefined): string | undefined {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString().slice(0, 10);
}

export type { TransactionDirection };
