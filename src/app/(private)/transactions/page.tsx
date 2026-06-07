import type { DashboardTransaction, TransactionFilters } from "../../../modules/transactions";

interface TransactionsPageProps {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

interface TransactionsDashboardProps {
  filters: TransactionFilters;
  transactions: DashboardTransaction[];
}

export default async function TransactionsPage({ searchParams }: TransactionsPageProps) {
  const resolvedSearchParams = searchParams ? await searchParams : {};
  const filters = toTransactionFilters(resolvedSearchParams);

  return <TransactionsDashboard filters={filters} transactions={[]} />;
}

export function TransactionsDashboard({ filters, transactions }: TransactionsDashboardProps) {
  return (
    <main className="dashboard-shell">
      <section className="dashboard-header" aria-labelledby="transactions-title">
        <p className="eyebrow">RD-Sync</p>
        <h1 id="transactions-title">Recent transactions</h1>
        <p className="lede">
          Employee-safe visibility into normalized bank movements. Bank sessions, credentials, and operational
          controls are intentionally excluded from this screen.
        </p>
      </section>

      <form className="filters" aria-label="Transaction filters">
        <label>
          Filter by bank
          <input name="bankId" defaultValue={filters.bankId} placeholder="popular, bhd, banreservas" />
        </label>
        <label>
          Filter by amount
          <input name="amount" defaultValue={filters.amount?.toString()} inputMode="decimal" placeholder="1500.50" />
        </label>
        <label>
          Filter by reference or concept
          <input name="query" defaultValue={filters.query} placeholder="Reference, concept, originator" />
        </label>
        <button type="submit">Apply filters</button>
      </form>

      {transactions.length === 0 ? (
        <section className="empty-state" aria-live="polite">
          <h2>No recent transactions are available</h2>
          <p>Transactions will appear here after ingestion stores normalized bank movements.</p>
        </section>
      ) : (
        <section aria-label="Transaction results" className="transaction-grid">
          {transactions.map((transaction) => (
            <article className="transaction-card" key={transaction.id}>
              <div>
                <p className="card-kicker">Banco: {transaction.bankId}</p>
                <h2>{transaction.reference ?? "No reference"}</h2>
                <p>{transaction.concept ?? "No concept provided"}</p>
                {transaction.originator ? <p>Ordenante: {transaction.originator}</p> : null}
              </div>
              <div className="amount-block">
                <strong>
                  {transaction.currency} {transaction.amount}
                </strong>
                <span>{transaction.reviewState.replace(/_/g, " ")}</span>
              </div>
            </article>
          ))}
        </section>
      )}
    </main>
  );
}

function toTransactionFilters(searchParams: Record<string, string | string[] | undefined>): TransactionFilters {
  return {
    bankId: firstValue(searchParams.bankId),
    amount: firstValue(searchParams.amount),
    query: firstValue(searchParams.query),
    currency: firstValue(searchParams.currency),
    accountFingerprint: firstValue(searchParams.accountFingerprint),
  };
}

function firstValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}
