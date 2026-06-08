import { Badge } from "../ui/badge";
import type { DashboardTransaction } from "../../modules/transactions";

interface TransactionRowProps {
  transaction: DashboardTransaction;
  actions?: React.ReactNode;
}

/**
 * Per-row visual contract (REQ-TX-UX-003):
 * - Shows postedAt formatted in the user locale
 * - Credit/debit indicator with text + colored badge (color is never the only signal)
 * - NO balance, session, credentials, MFA, or admin-only fields
 * - Source hash and metadata are deliberately excluded from the DashboardTransaction
 *   shape, so the data minimisation guarantee holds at the type level too.
 */
export function TransactionRow({ transaction, actions }: TransactionRowProps) {
  const isCredit = transaction.direction === "credit";
  const directionLabel = isCredit ? "Credit" : "Debit";
  const directionSymbol = isCredit ? "+" : "−";
  const formattedAmount = `${directionSymbol} ${transaction.currency} ${transaction.amount}`;
  const postedAtLabel = formatPostedAt(transaction.postedAt);

  return (
    <article className="flex flex-col gap-4 rounded-lg border border-border bg-card p-5 sm:flex-row sm:justify-between">
      <div className="grid gap-2">
        <p className="m-0 text-sm text-muted-foreground">
          Banco: {transaction.bankId} · {transaction.accountFingerprint}
        </p>
        <h2 className="text-lg font-semibold text-foreground">
          {transaction.reference ?? "No reference"}
        </h2>
        {transaction.concept ? (
          <p className="m-0 text-sm text-card-foreground">{transaction.concept}</p>
        ) : null}
        {transaction.originator ? (
          <p className="m-0 text-sm text-muted-foreground">Ordenante: {transaction.originator}</p>
        ) : null}
        <p className="m-0 text-xs text-muted-foreground">
          Posted {postedAtLabel}
        </p>
      </div>
      <div className="grid justify-items-end gap-2">
        <Badge variant={isCredit ? "success" : "warning"} aria-label={directionLabel}>
          {directionLabel}
        </Badge>
        <strong className="text-2xl leading-none text-foreground">{formattedAmount}</strong>
        <span className="text-sm text-muted-foreground">
          {transaction.reviewState.replace(/_/g, " ")}
        </span>
        {actions ? <div className="mt-2">{actions}</div> : null}
      </div>
    </article>
  );
}

function formatPostedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
