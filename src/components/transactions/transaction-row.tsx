import Image from "next/image";

import { Badge } from "../ui/badge";
import { ReviewActions } from "./review-actions";
import { getBankMeta } from "../../lib/banks";
import { REVIEW_STATE_LABELS, type ReviewState } from "../../modules/transactions/labels";
import type { DashboardTransaction } from "../../modules/transactions";

interface TransactionRowProps {
  transaction: DashboardTransaction;
  actions?: React.ReactNode;
  reviewerMode: boolean;
}

/**
 * Per-row visual contract (REQ-TX-UX-003):
 * - Feed item layout: bank icon + text block + amount.
 * - Credit/debit indicator with text and colored amount (color is never the only signal).
 * - Bank name, account fingerprint, and time rendered in a structured information hierarchy.
 * - NO balance, session, credentials, MFA, or admin-only fields.
 */
export function TransactionRow({ transaction, actions, reviewerMode }: TransactionRowProps) {
  const isCredit = transaction.direction === "credit";
  const directionLabel = isCredit ? "Crédito" : "Débito";
  const amountClass = isCredit ? "text-emerald-300" : "text-amber-300";
  const amountSign = isCredit ? "+" : "−";
  const formattedNumericAmount = formatTransactionAmount(transaction.amount);
  const formattedAmount = `${amountSign} ${transaction.currency} ${formattedNumericAmount}`;
  const formattedTime = formatPostedAt(transaction.postedAt);
  const bankMeta = getBankMeta(transaction.bankId);

  return (
    <div role="row">
      <div className="flex items-center gap-3.5 px-4 py-3.5 hover:bg-white/[0.02] transition-colors">
        <Image
          src={bankMeta.logoSrc}
          width={40}
          height={40}
          alt={bankMeta.name}
          unoptimized
          className="rounded-[10px] flex-shrink-0"
        />

        <div className="flex-1 min-w-0">
          <p className="font-medium text-foreground truncate">
            {transaction.concept ?? transaction.reference ?? (
              <span className="italic text-muted-foreground">Sin referencia</span>
            )}
          </p>
          <p className="text-xs text-muted-foreground truncate">
            {bankMeta.name} · {transaction.accountFingerprint} · {formattedTime}
            {transaction.reference ? <> · {transaction.reference}</> : null}
          </p>
          {transaction.originator ? (
            <p className="text-xs text-muted-foreground truncate">{transaction.originator}</p>
          ) : null}
          {reviewerMode ? (
            <div className="mt-0.5">
              <ReviewStatePill state={transaction.reviewState} />
            </div>
          ) : null}
        </div>

        <div className="flex-shrink-0 text-right">
          <strong
            className={`font-mono text-sm font-semibold tabular-nums tracking-tight ${amountClass}`}
            aria-label={`${directionLabel} de ${transaction.currency} ${formattedNumericAmount}`}
          >
            {formattedAmount}
          </strong>
          <p className="text-xs text-muted-foreground">{transaction.currency}</p>
        </div>
      </div>

      {actions || reviewerMode ? (
        <div className="border-t border-border/60 bg-muted/20 px-4 py-3">
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
    </div>
  );
}

function ReviewStatePill({ state }: { state: DashboardTransaction["reviewState"] }) {
  const { variant, label } = reviewStateVisual(state);
  return (
    <Badge variant={variant} className="gap-1 text-[10px] px-1.5 py-0">
      <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />
      {label}
    </Badge>
  );
}

function reviewStateVisual(state: ReviewState): {
  variant: "default" | "secondary" | "warning" | "destructive" | "success" | "outline";
  label: string;
} {
  // Single source of truth — src/modules/transactions/labels.ts.
  // Variants keep a stable color contract (success/warning/etc) so the pill
  // is recognizable even before the label is read.
  const label = REVIEW_STATE_LABELS[state];
  switch (state) {
    case "new":
      return { variant: "outline", label };
    case "seen":
      return { variant: "secondary", label };
    case "internally_validated":
      return { variant: "success", label };
    case "needs_review":
      return { variant: "warning", label };
    case "ignored":
      return { variant: "outline", label };
    default:
      return { variant: "outline", label };
  }
}

function formatPostedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("es-DO", {
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    day: "2-digit",
    timeZone: "America/Santo_Domingo",
  });
}

function formatTransactionAmount(value: string): string {
  const numericValue = Number(value.replace(/,/g, ""));
  if (!Number.isFinite(numericValue)) return value;

  return new Intl.NumberFormat("es-DO", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(numericValue);
}
