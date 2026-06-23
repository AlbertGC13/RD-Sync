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
import { BANKING_TIMEZONE, getSantoDomingoDayKey, santoDomingoDayRange } from "../../../lib/banking-day";

export const metadata: Metadata = {
  title: "Transacciones recientes · RD-Sync",
  description: "Visibilidad segura para empleados sobre movimientos bancarios normalizados.",
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
        title="Transacciones recientes"
        actions={
          <Badge variant="outline" className="gap-1.5">
            <Sparkles className="h-3 w-3 text-primary" aria-hidden />
            {totals.total} {totals.total === 1 ? "movimiento" : "movimientos"} ·{" "}
            <span className="text-emerald-300 tabular-nums">+{totals.credits}</span> /{" "}
            <span className="text-amber-300 tabular-nums">−{totals.debits}</span>
          </Badge>
        }
      />

      <FilterBar filters={filters} activeCount={activeCount} resultCount={transactions.length} />

      {transactions.length === 0 ? (
        <EmptyState
          icon={<Inbox className="h-6 w-6" aria-hidden />}
          title="No hay transacciones recientes disponibles"
          description={
            activeCount > 0
              ? "Ninguna transacción coincide con los filtros actuales. Limpia los filtros activos para ver todos los movimientos recientes."
              : "Las transacciones aparecerán aquí después de que la ingesta almacene los movimientos bancarios normalizados."
          }
          action={
            activeCount > 0 ? (
              <Link
                href="/transactions"
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-2 text-sm font-medium text-foreground transition-colors hover:border-primary hover:text-primary"
              >
                <Receipt className="h-3.5 w-3.5" aria-hidden />
                Limpiar filtros
              </Link>
            ) : undefined
          }
        />
      ) : (
        <section aria-label="Resultados de transacciones">
          <GroupedTransactionList transactions={transactions} reviewerMode={reviewerMode} />
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
        title="Transacciones recientes"
        actions={
          <Badge variant="outline" className="gap-1.5">
            <Sparkles className="h-3 w-3 text-primary" aria-hidden />
            {totals.total} {totals.total === 1 ? "movimiento" : "movimientos"} ·{" "}
            <span className="text-emerald-300 tabular-nums">+{totals.credits}</span> /{" "}
            <span className="text-amber-300 tabular-nums">−{totals.debits}</span>
          </Badge>
        }
      />
      <FilterBar filters={filters} activeCount={activeCount} resultCount={transactions.length} />
      {transactions.length === 0 ? (
        <EmptyState
          icon={<Inbox className="h-6 w-6" aria-hidden />}
          title="No hay transacciones recientes disponibles"
          description={
            activeCount > 0
              ? "Ninguna transacción coincide con los filtros activos. Limpia los filtros para ver todos los movimientos recientes."
              : "Las transacciones aparecerán aquí después de que la ingesta almacene los movimientos bancarios normalizados."
          }
        />
      ) : (
        <section aria-label="Resultados de transacciones">
          <GroupedTransactionList transactions={transactions} reviewerMode={reviewerMode} />
        </section>
      )}
    </div>
  );
}

interface GroupedTransactionListProps {
  transactions: DashboardTransaction[];
  reviewerMode: boolean;
}

function GroupedTransactionList({ transactions, reviewerMode }: GroupedTransactionListProps) {
  const grouped = transactions.reduce<Record<string, DashboardTransaction[]>>((acc, tx) => {
    // Group by the Santo Domingo banking day, NOT the UTC day. A postedAt
    // at 03:30Z belongs to the previous local day for Dominican operators —
    // see src/lib/banking-day.ts.
    const key = getSantoDomingoDayKey(tx.postedAt);
    (acc[key] ??= []).push(tx);
    return acc;
  }, {});

  return (
    <>
      {Object.entries(grouped).map(([date, txs]) => (
        <div key={date}>
          <div className="flex items-center gap-3 px-4 py-2 sticky top-0 bg-background/80 backdrop-blur-sm">
            <span className="text-xs font-medium text-muted-foreground whitespace-nowrap">
              {formatDate(date)}
            </span>
            <div className="flex-1 h-px bg-border" />
            <span className="text-xs text-muted-foreground/60">
              {txs.length} {txs.length === 1 ? "movimiento" : "movimientos"}
            </span>
          </div>
          <div className="mx-4 mb-4 rounded-xl border border-border/60 bg-card divide-y divide-border/40 overflow-hidden">
            {txs.map((tx) => (
              <TransactionRow key={tx.id} transaction={tx} reviewerMode={reviewerMode} />
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

const DATE_HEADER_FORMATTER = new Intl.DateTimeFormat("es-DO", {
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: BANKING_TIMEZONE,
});

function formatDate(dayKey: string): string {
  // dayKey is a Santo Domingo YYYY-MM-DD string produced by getSantoDomingoDayKey.
  // We re-parse it as noon-local in the same timezone so the formatter does
  // not flip the bucket back to a different day.
  const [year, month, day] = dayKey.split("-").map(Number);
  if (!year || !month || !day) return dayKey;
  // Construct a date that is unambiguously noon on that local day in Santo
  // Domingo by using an offset equivalent to UTC-4 (DR observes no DST).
  const local = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  return DATE_HEADER_FORMATTER.format(local);
}

function toTransactionFilters(
  searchParams: Record<string, string | string[] | undefined>,
): TransactionFilters {
  const rawDateFrom = firstValue(searchParams.dateFrom);
  const rawDateTo = firstValue(searchParams.dateTo);
  // Interpret date inputs as Santo Domingo local day boundaries, then convert
  // to UTC instants for storage comparison. Without this, `dateTo=2026-06-07`
  // would become `2026-06-07T00:00:00Z` and exclude most of June 7 in DR
  // (UTC-4). `santoDomingoDayRange` returns start-of-local-day for dateFrom
  // and end-of-local-day (23:59:59.999) for dateTo.
  return {
    bankId: firstValue(searchParams.bankId),
    amount: firstValue(searchParams.amount),
    query: firstValue(searchParams.query),
    currency: firstValue(searchParams.currency)?.toUpperCase(),
    accountFingerprint: firstValue(searchParams.accountFingerprint),
    dateFrom: rawDateFrom ? santoDomingoDayRange(rawDateFrom).start : undefined,
    dateTo: rawDateTo ? santoDomingoDayRange(rawDateTo).end : undefined,
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
