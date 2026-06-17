import type { Metadata } from "next";
import Link from "next/link";
import { Inbox, Receipt, Sparkles } from "lucide-react";

import { listTransactionsForPage } from "../../api/transactions/defaults";
import { canReviewTransactions } from "../../../modules/auth";
import { getCurrentPrincipal } from "../../../modules/auth/server";
import {
  type DashboardTransaction,
  type TransactionFilters,
  type TransactionDirection,
} from "../../../modules/transactions";
import { TransactionRow } from "../../../components/transactions/transaction-row";
import { FilterBar } from "../../../components/transactions/filter-bar";
import { EmptyState } from "../../../components/ui/empty-state";
import { PageHeader } from "../../../components/ui/page-header";
import { Badge } from "../../../components/ui/badge";

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

  // The (private) layout already gates this route via getCurrentPrincipal().
  // Here we only decide whether to surface reviewer affordances (FR-011).
  const principal = await getCurrentPrincipal();
  const reviewerMode = canReviewTransactions(principal);

  const activeCount = countActiveFilters(filters);
  const totals = summarizeTotals(transactions);

  return (
    <div className="grid gap-6">
      <PageHeader
        eyebrow="Employee view"
        title="Recent transactions"
        description="Employee-safe visibility into normalized bank movements. Bank sessions, credentials, and operational controls are intentionally excluded from this screen."
        actions={
          <Badge variant="outline" className="gap-1.5">
            <Sparkles className="h-3 w-3 text-primary" aria-hidden />
            {totals.total} {totals.total === 1 ? "movement" : "movements"} ·{" "}
            <span className="text-emerald-300 tabular-nums">+{totals.credits}</span> /{" "}
            <span className="text-amber-300 tabular-nums">−{totals.debits}</span>
          </Badge>
        }
      />

      <FilterBar filters={filters} activeCount={activeCount} resultCount={transactions.length} />

      {transactions.length === 0 ? (
        <EmptyState
          icon={<Inbox className="h-6 w-6" aria-hidden />}
          title="No recent transactions are available"
          description={
            activeCount > 0
              ? "No transactions match the current filters. Clear the active filters above to see all recent movements."
              : "Transactions will appear here after ingestion stores normalized bank movements."
          }
          action={
            activeCount > 0 ? (
              <Link
                href="/transactions"
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-2 text-sm font-medium text-foreground transition-colors hover:border-primary hover:text-primary"
              >
                <Receipt className="h-3.5 w-3.5" aria-hidden />
                Clear filters
              </Link>
            ) : undefined
          }
        />
      ) : (
        <section aria-label="Transaction results" className="grid gap-3">
          {transactions.map((transaction) => (
            <TransactionRow
              key={transaction.id}
              transaction={transaction}
              reviewerMode={reviewerMode}
            />
          ))}
        </section>
      )}
    </div>
  );
}

interface TransactionsDashboardProps {
  filters: TransactionFilters;
  transactions: DashboardTransaction[];
  reviewerMode: boolean;
}

/**
 * Standalone dashboard component preserved for unit testing without
 * the server-side `headers()` call.
 */
export function TransactionsDashboard({
  filters,
  transactions,
  reviewerMode,
}: TransactionsDashboardProps) {
  const activeCount = countActiveFilters(filters);
  const totals = summarizeTotals(transactions);

  return (
    <div className="grid gap-6">
      <PageHeader
        eyebrow="Employee view"
        title="Recent transactions"
        description="Employee-safe visibility into normalized bank movements. Bank sessions, credentials, and operational controls are intentionally excluded from this screen."
        actions={
          <Badge variant="outline" className="gap-1.5">
            <Sparkles className="h-3 w-3 text-primary" aria-hidden />
            {totals.total} {totals.total === 1 ? "movement" : "movements"} ·{" "}
            <span className="text-emerald-300 tabular-nums">+{totals.credits}</span> /{" "}
            <span className="text-amber-300 tabular-nums">−{totals.debits}</span>
          </Badge>
        }
      />
      <FilterBar filters={filters} activeCount={activeCount} resultCount={transactions.length} />
      {transactions.length === 0 ? (
        <EmptyState
          icon={<Inbox className="h-6 w-6" aria-hidden />}
          title="No recent transactions are available"
          description={
            activeCount > 0
              ? "No transactions match the current filters. Clear the active filters above to see all recent movements."
              : "Transactions will appear here after ingestion stores normalized bank movements."
          }
        />
      ) : (
        <section aria-label="Transaction results" className="grid gap-3">
          {transactions.map((transaction) => (
            <TransactionRow
              key={transaction.id}
              transaction={transaction}
              reviewerMode={reviewerMode}
            />
          ))}
        </section>
      )}
    </div>
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

function countActiveFilters(filters: TransactionFilters): number {
  let count = 0;
  if (filters.bankId) count += 1;
  if (filters.amount) count += 1;
  if (filters.query) count += 1;
  if (filters.currency) count += 1;
  if (filters.accountFingerprint) count += 1;
  if (filters.dateFrom) count += 1;
  if (filters.dateTo) count += 1;
  if (filters.reviewState) count += 1;
  return count;
}

function summarizeTotals(transactions: readonly DashboardTransaction[]) {
  let credits = 0;
  let debits = 0;
  for (const t of transactions) {
    if (t.direction === "credit") credits += 1;
    else debits += 1;
  }
  return { total: transactions.length, credits, debits };
}

export type { TransactionDirection };
