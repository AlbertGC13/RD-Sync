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

  const hasAdvancedFilters = !!(
    filters.bankId ||
    filters.amount ||
    filters.currency ||
    filters.accountFingerprint ||
    filters.dateFrom ||
    filters.dateTo ||
    filters.reviewState
  );
  const [isExpanded, setIsExpanded] = useState(hasAdvancedFilters);

  const advancedActiveCount = useMemo(
    () =>
      [bankId, amount, currency, accountFingerprint, dateFrom, dateTo, reviewState].filter(
        Boolean,
      ).length,
    [bankId, amount, currency, accountFingerprint, dateFrom, dateTo, reviewState],
  );

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
      <span className="sr-only">Filter transactions</span>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          applyFilters();
        }}
      >
        <div className="flex items-center gap-2 px-4 py-3">
          <div className="relative flex-1">
            <Search
              className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              id="filter-query"
              name="query"
              placeholder="Search reference, concept, originator…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="pl-9"
            />
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setIsExpanded(!isExpanded)}
            aria-expanded={isExpanded}
            aria-controls="filter-advanced-panel"
          >
            <Filter className="h-3.5 w-3.5" aria-hidden />
            Filters
            {advancedActiveCount > 0 ? (
              <Badge variant="secondary" className="ml-1">
                {advancedActiveCount}
              </Badge>
            ) : null}
          </Button>
          <Button type="submit" size="sm" disabled={isPending}>
            {isPending ? "Applying…" : "Apply filters"}
          </Button>
        </div>

        <div
          id="filter-advanced-panel"
          className={
            isExpanded
              ? "grid gap-4 border-t border-border/60 px-4 pb-4 pt-3 sm:grid-cols-2 lg:grid-cols-3"
              : "hidden"
          }
        >
          <Field icon={Building2} label="Bank" htmlFor="filter-bankId">
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
          </div>
        </div>
      </form>

      {activeChips.length > 0 ? (
        <div
          className="flex flex-wrap items-center gap-1.5 border-t border-border/60 bg-muted/30 px-4 py-2.5"
          aria-label="Active filters"
        >
          <span className="mr-auto inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <CircleDot className="h-3 w-3 text-success" aria-hidden />
            {resultCount} {resultCount === 1 ? "result" : "results"}
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
