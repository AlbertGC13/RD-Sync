"use client";

import type { ReactNode } from "react";
import { useCallback, useMemo, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Building2,
  CalendarClock,
  CircleDot,
  CreditCard,
  FileText,
  Filter,
  Hash,
  Search,
  Wallet,
  X,
} from "lucide-react";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import type { TransactionFilters } from "../../modules/transactions";

interface FilterBarProps {
  filters: TransactionFilters;
  /** Number of active filters, used to drive the "Clear all" affordance. */
  activeCount: number;
  /** Total results so the user can decide if filters are too narrow. */
  resultCount: number;
}

const BANK_OPTIONS = [
  { value: "popular", label: "Banco Popular" },
  { value: "bhd", label: "BHD" },
  { value: "banreservas", label: "Banreservas" },
] as const;

const CURRENCY_OPTIONS = [
  { value: "DOP", label: "DOP · Dominican Peso" },
  { value: "USD", label: "USD · US Dollar" },
  { value: "EUR", label: "EUR · Euro" },
] as const;

const REVIEW_STATE_OPTIONS = [
  { value: "new", label: "New" },
  { value: "seen", label: "Seen" },
  { value: "internally_validated", label: "Internally validated" },
  { value: "needs_review", label: "Needs review" },
  { value: "ignored", label: "Ignored" },
] as const;

export function FilterBar({ filters, activeCount, resultCount }: FilterBarProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const [bankId, setBankId] = useState(filters.bankId ?? "");
  const [amount, setAmount] = useState(filters.amount?.toString() ?? "");
  const [query, setQuery] = useState(filters.query ?? "");
  const [currency, setCurrency] = useState(filters.currency ?? "");
  const [accountFingerprint, setAccountFingerprint] = useState(
    filters.accountFingerprint ?? "",
  );
  const [dateFrom, setDateFrom] = useState(toDateInputValue(filters.dateFrom));
  const [dateTo, setDateTo] = useState(toDateInputValue(filters.dateTo));
  const [reviewState, setReviewState] = useState(filters.reviewState ?? "");

  const activeChips = useMemo(
    () =>
      [
        bankId && { key: "bankId", label: `Bank: ${bankId}`, clear: () => setBankId("") },
        amount && { key: "amount", label: `Amount: ${amount}`, clear: () => setAmount("") },
        query && { key: "query", label: `Search: ${query}`, clear: () => setQuery("") },
        currency && { key: "currency", label: `Currency: ${currency}`, clear: () => setCurrency("") },
        accountFingerprint && {
          key: "accountFingerprint",
          label: `Account: ${accountFingerprint}`,
          clear: () => setAccountFingerprint(""),
        },
        dateFrom && { key: "dateFrom", label: `From: ${dateFrom}`, clear: () => setDateFrom("") },
        dateTo && { key: "dateTo", label: `To: ${dateTo}`, clear: () => setDateTo("") },
        reviewState && {
          key: "reviewState",
          label: `State: ${reviewState.replace(/_/g, " ")}`,
          clear: () => setReviewState(""),
        },
      ].filter(Boolean) as { key: string; label: string; clear: () => void }[],
    [bankId, amount, query, currency, accountFingerprint, dateFrom, dateTo, reviewState],
  );

  const applyFilters = useCallback(() => {
    const next = new URLSearchParams(searchParams.toString());
    const setOrDelete = (key: string, value: string | undefined) => {
      if (value && value.length > 0) {
        next.set(key, value);
      } else {
        next.delete(key);
      }
    };
    setOrDelete("bankId", bankId);
    setOrDelete("amount", amount);
    setOrDelete("query", query);
    setOrDelete("currency", currency);
    setOrDelete("accountFingerprint", accountFingerprint);
    setOrDelete("dateFrom", dateFrom);
    setOrDelete("dateTo", dateTo);
    setOrDelete("reviewState", reviewState);
    startTransition(() => {
      router.push(`/transactions?${next.toString()}`);
    });
  }, [
    searchParams,
    bankId,
    amount,
    query,
    currency,
    accountFingerprint,
    dateFrom,
    dateTo,
    reviewState,
    router,
  ]);

  const clearAll = useCallback(() => {
    setBankId("");
    setAmount("");
    setQuery("");
    setCurrency("");
    setAccountFingerprint("");
    setDateFrom("");
    setDateTo("");
    setReviewState("");
    startTransition(() => {
      router.push("/transactions");
    });
  }, [router]);

  return (
    <section
      aria-label="Transaction filters"
      className="rounded-xl border border-border/80 bg-card/60 shadow-sm shadow-black/20"
    >
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 px-5 py-3">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Filter className="h-4 w-4 text-muted-foreground" aria-hidden />
          <span>Filter transactions</span>
          {activeCount > 0 ? (
            <Badge variant="secondary" className="ml-1">
              {activeCount} active
            </Badge>
          ) : null}
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <CircleDot className="h-3 w-3 text-success" aria-hidden />
            {resultCount} {resultCount === 1 ? "result" : "results"}
          </span>
        </div>
      </header>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          applyFilters();
        }}
        className="grid gap-4 px-5 py-4 sm:grid-cols-2 lg:grid-cols-3"
      >
        <Field
          icon={Building2}
          label="Bank"
          htmlFor="filter-bankId"
        >
          <Select value={bankId} onValueChange={setBankId}>
            <SelectTrigger id="filter-bankId" className="w-full">
              <SelectValue placeholder="All banks" />
            </SelectTrigger>
            <SelectContent>
              {BANK_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field icon={Wallet} label="Amount" htmlFor="filter-amount">
          <Input
            id="filter-amount"
            name="amount"
            inputMode="decimal"
            placeholder="e.g. 1500.50"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
        </Field>

        <Field icon={CreditCard} label="Currency" htmlFor="filter-currency">
          <Select value={currency} onValueChange={setCurrency}>
            <SelectTrigger id="filter-currency" className="w-full">
              <SelectValue placeholder="Any currency" />
            </SelectTrigger>
            <SelectContent>
              {CURRENCY_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field
          icon={Search}
          label="Search reference, concept, originator"
          htmlFor="filter-query"
          className="sm:col-span-2 lg:col-span-3"
        >
          <Input
            id="filter-query"
            name="query"
            placeholder="e.g. factura, REF-1234, Cliente Uno"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </Field>

        <Field icon={Hash} label="Account fingerprint" htmlFor="filter-accountFingerprint">
          <Input
            id="filter-accountFingerprint"
            name="accountFingerprint"
            placeholder="acct-main"
            value={accountFingerprint}
            onChange={(event) => setAccountFingerprint(event.target.value)}
          />
        </Field>

        <Field icon={CalendarClock} label="From" htmlFor="filter-dateFrom">
          <Input
            id="filter-dateFrom"
            name="dateFrom"
            type="date"
            value={dateFrom ?? ""}
            onChange={(event) => setDateFrom(event.target.value)}
          />
        </Field>

        <Field icon={CalendarClock} label="To" htmlFor="filter-dateTo">
          <Input
            id="filter-dateTo"
            name="dateTo"
            type="date"
            value={dateTo ?? ""}
            onChange={(event) => setDateTo(event.target.value)}
          />
        </Field>

        <Field icon={FileText} label="Review state" htmlFor="filter-reviewState">
          <Select value={reviewState} onValueChange={setReviewState}>
            <SelectTrigger id="filter-reviewState" className="w-full">
              <SelectValue placeholder="Any state" />
            </SelectTrigger>
            <SelectContent>
              {REVIEW_STATE_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-3 lg:justify-end">
          {activeCount > 0 ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={clearAll}
              disabled={isPending}
            >
              <X className="h-3.5 w-3.5" aria-hidden />
              Clear all
            </Button>
          ) : null}
          <Button type="submit" size="sm" disabled={isPending}>
            <Filter className="h-3.5 w-3.5" aria-hidden />
            {isPending ? "Applying…" : "Apply filters"}
          </Button>
        </div>
      </form>

      {activeChips.length > 0 ? (
        <div
          className="flex flex-wrap items-center gap-1.5 border-t border-border/60 bg-muted/30 px-5 py-2.5"
          aria-label="Active filters"
        >
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Active:
          </span>
          {activeChips.map((chip) => (
            <button
              key={chip.key}
              type="button"
              onClick={chip.clear}
              className="group inline-flex items-center gap-1 rounded-full border border-border bg-background px-2.5 py-0.5 text-xs text-foreground transition-colors hover:border-primary/60 hover:bg-primary/10"
            >
              {chip.label}
              <X className="h-3 w-3 text-muted-foreground group-hover:text-primary" aria-hidden />
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}

interface FieldProps {
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  label: string;
  htmlFor: string;
  className?: string;
  children: ReactNode;
}

function Field({ icon: Icon, label, htmlFor, className, children }: FieldProps) {
  return (
    <div className={`grid gap-1.5 ${className ?? ""}`}>
      <label
        htmlFor={htmlFor}
        className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"
      >
        <Icon className="h-3.5 w-3.5" aria-hidden />
        {label}
      </label>
      {children}
    </div>
  );
}

function toDateInputValue(value: string | Date | undefined): string | undefined {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString().slice(0, 10);
}

// User icon is the canonical "originator" indicator and lives in the sibling
// transaction-row component. No reference needed here.
