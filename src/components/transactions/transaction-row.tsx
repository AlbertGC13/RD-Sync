import { ArrowDownLeft, ArrowUpRight, Building2, Hash, User } from "lucide-react";

import { Badge } from "../ui/badge";
import { Card, CardContent } from "../ui/card";
import { ReviewActions } from "./review-actions";
import type { DashboardTransaction } from "../../modules/transactions";

interface TransactionRowProps {
  transaction: DashboardTransaction;
  actions?: React.ReactNode;
  reviewerMode: boolean;
}

/**
 * Per-row visual contract (REQ-TX-UX-003):
 * - Shows postedAt in a human-friendly relative+absolute format.
 * - Credit/debit indicator with text + colored badge + directional icon
 *   (color is never the only signal).
 * - Bank name, account fingerprint, reference, concept, originator
 *   rendered in a structured information hierarchy.
 * - NO balance, session, credentials, MFA, or admin-only fields.
 */
export function TransactionRow({ transaction, actions, reviewerMode }: TransactionRowProps) {
  const isCredit = transaction.direction === "credit";
  const DirectionIcon = isCredit ? ArrowDownLeft : ArrowUpRight;
  const directionLabel = isCredit ? "Credit" : "Debit";
  const amountClass = isCredit ? "text-emerald-300" : "text-amber-300";
  const amountSign = isCredit ? "+" : "−";
  const formattedAmount = `${amountSign} ${transaction.currency} ${transaction.amount}`;
  const { absolute, relative } = formatPostedAt(transaction.postedAt);
  const reviewStateLabel = transaction.reviewState.replace(/_/g, " ");

  return (
    <Card className="overflow-hidden transition-colors hover:border-border">
      <CardContent className="grid gap-4 p-0">
        <div className="grid gap-4 p-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
          <div className="grid gap-3">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <Building2 className="h-3.5 w-3.5" aria-hidden />
                {formatBankName(transaction.bankId)}
              </span>
              <span aria-hidden>·</span>
              <span className="inline-flex items-center gap-1.5">
                <Hash className="h-3.5 w-3.5" aria-hidden />
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground">
                  {transaction.accountFingerprint}
                </code>
              </span>
            </div>

            <div className="grid gap-1">
              <h3 className="text-base font-semibold leading-tight tracking-tight text-foreground">
                {transaction.reference ?? (
                  <span className="italic text-muted-foreground">No reference</span>
                )}
              </h3>
              {transaction.concept ? (
                <p className="text-sm text-foreground/80">{transaction.concept}</p>
              ) : null}
              {transaction.originator ? (
                <p className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
                  <User className="h-3.5 w-3.5" aria-hidden />
                  <span>{transaction.originator}</span>
                </p>
              ) : null}
            </div>

            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span title={absolute}>
                <time dateTime={transaction.postedAt}>{relative}</time>
              </span>
              <span aria-hidden>·</span>
              <ReviewStatePill state={transaction.reviewState} />
            </div>
          </div>

          <div className="flex flex-row items-center justify-between gap-3 sm:flex-col sm:items-end sm:justify-start">
            <Badge variant={isCredit ? "success" : "warning"} className="gap-1">
              <DirectionIcon className="h-3 w-3" aria-hidden />
              {directionLabel}
            </Badge>
            <strong
              className={`font-mono text-xl font-semibold tabular-nums tracking-tight ${amountClass}`}
              aria-label={`${directionLabel} of ${transaction.currency} ${transaction.amount}`}
            >
              {formattedAmount}
            </strong>
            <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
              {reviewStateLabel}
            </span>
          </div>
        </div>

        {actions || reviewerMode ? (
          <div className="border-t border-border/60 bg-muted/20 px-5 py-3">
            {reviewerMode ? (
              <ReviewActions
                transactionId={transaction.id}
                currentState={transaction.reviewState}
              />
            ) : (
              actions
            )}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function ReviewStatePill({ state }: { state: DashboardTransaction["reviewState"] }) {
  const { variant, label } = reviewStateVisual(state);
  return (
    <Badge variant={variant} className="gap-1">
      <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />
      {label}
    </Badge>
  );
}

function reviewStateVisual(state: DashboardTransaction["reviewState"]): {
  variant: "default" | "secondary" | "warning" | "destructive" | "success" | "outline";
  label: string;
} {
  switch (state) {
    case "new":
      return { variant: "outline", label: "New" };
    case "seen":
      return { variant: "secondary", label: "Seen" };
    case "internally_validated":
      return { variant: "success", label: "Internally validated" };
    case "needs_review":
      return { variant: "warning", label: "Needs review" };
    case "ignored":
      return { variant: "outline", label: "Ignored" };
  }
}

function formatBankName(bankId: string): string {
  const names: Record<string, string> = {
    banreservas: "Banreservas",
    bhd: "BHD",
    popular: "Banco Popular",
  };
  return names[bankId] ?? bankId;
}

function formatPostedAt(value: string): { absolute: string; relative: string } {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { absolute: value, relative: value };
  const absolute = date.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  return { absolute, relative: relativeTime(date) };
}

function relativeTime(date: Date): string {
  const diffMs = date.getTime() - Date.now();
  const diffSec = Math.round(diffMs / 1000);
  const diffMin = Math.round(diffSec / 60);
  const diffHour = Math.round(diffMin / 60);
  const diffDay = Math.round(diffHour / 24);
  const formatter = new Intl.RelativeTimeFormat("en-US", { numeric: "auto" });
  if (Math.abs(diffSec) < 60) return formatter.format(diffSec, "second");
  if (Math.abs(diffMin) < 60) return formatter.format(diffMin, "minute");
  if (Math.abs(diffHour) < 24) return formatter.format(diffHour, "hour");
  if (Math.abs(diffDay) < 7) return formatter.format(diffDay, "day");
  return date.toLocaleDateString("en-US", { month: "short", day: "2-digit" });
}
