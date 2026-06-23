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
import { REVIEW_STATE_LABELS, type ReviewState } from "../../modules/transactions/labels";
import { getSantoDomingoDayKey } from "../../lib/banking-day";

interface FilterBarProps {
  filters: TransactionFilters;
  /** Number of active filters, used to drive the "Limpiar todo" affordance. */
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
  { value: "DOP", label: "DOP — Peso dominicano" },
  { value: "USD", label: "USD — Dólar estadounidense" },
  { value: "EUR", label: "EUR — Euro" },
] as const;

const REVIEW_STATE_VALUES: readonly ReviewState[] = [
  "new",
  "seen",
  "internally_validated",
  "needs_review",
  "ignored",
];

/**
 * Builds the target URL for removing a single filter from the committed query
 * string. Exported so the chip-removal navigation behaviour is unit-testable
 * without a DOM — the project's test environment is `node` (no jsdom), so
 * click handlers cannot be exercised via event simulation.
 */
export function buildFilterRemovalUrl(
  currentSearchParams: URLSearchParams,
  removedKey: string,
): string {
  const next = new URLSearchParams(currentSearchParams.toString());
  next.delete(removedKey);
  const qs = next.toString();
  return qs ? `/transactions?${qs}` : "/transactions";
}

/**
 * Performs the chip-removal navigation: pushes the URL produced by
 * `buildFilterRemovalUrl` to the router. Exported so the behavioural
 * contract — "clicking a filter chip re-navigates with the filter removed"
 * — is unit-testable in the project's `node` test environment, where click
 * handlers cannot be exercised via event simulation.
 */
export function removeFilterAndNavigate(
  searchParams: URLSearchParams,
  key: string,
  router: ReturnType<typeof useRouter>,
): void {
  router.push(buildFilterRemovalUrl(searchParams, key));
}

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
        bankId && { key: "bankId", name: "Banco", value: bankId, label: `Banco: ${bankId}` },
        amount && { key: "amount", name: "Monto", value: amount, label: `Monto: ${amount}` },
        query && { key: "query", name: "Búsqueda", value: query, label: `Búsqueda: ${query}` },
        currency && {
          key: "currency",
          name: "Moneda",
          value: currency,
          label: `Moneda: ${currency}`,
        },
        accountFingerprint && {
          key: "accountFingerprint",
          name: "Cuenta",
          value: accountFingerprint,
          label: `Cuenta: ${accountFingerprint}`,
        },
        dateFrom && {
          key: "dateFrom",
          name: "Desde",
          value: dateFrom,
          label: `Desde: ${dateFrom}`,
        },
        dateTo && { key: "dateTo", name: "Hasta", value: dateTo, label: `Hasta: ${dateTo}` },
        reviewState && {
          key: "reviewState",
          name: "Estado",
          value: REVIEW_STATE_LABELS[reviewState as ReviewState] ?? reviewState,
          label: `Estado: ${REVIEW_STATE_LABELS[reviewState as ReviewState] ?? reviewState}`,
        },
      ].filter(Boolean) as { key: string; name: string; value: string; label: string }[],
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

  /**
   * Removes a single filter: clears its local draft state AND re-navigates
   * immediately with the filter removed from the committed URL. Without the
   * navigation, the list would stay stale until "Apply" is clicked.
   */
  const removeFilter = useCallback(
    (key: string) => {
      switch (key) {
        case "bankId":
          setBankId("");
          break;
        case "amount":
          setAmount("");
          break;
        case "query":
          setQuery("");
          break;
        case "currency":
          setCurrency("");
          break;
        case "accountFingerprint":
          setAccountFingerprint("");
          break;
        case "dateFrom":
          setDateFrom("");
          break;
        case "dateTo":
          setDateTo("");
          break;
        case "reviewState":
          setReviewState("");
          break;
      }
      startTransition(() => {
        removeFilterAndNavigate(searchParams, key, router);
      });
    },
    [searchParams, router],
  );

  return (
    <section
      aria-label="Filtros de transacciones"
      className="rounded-xl border border-border/80 bg-card/60 shadow-sm shadow-black/20"
    >
      <span className="sr-only">Filtros de transacciones</span>

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
              placeholder="Buscar referencia, concepto, originador…"
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
            Filtros
            {advancedActiveCount > 0 ? (
              <Badge variant="secondary" className="ml-1">
                {advancedActiveCount}
              </Badge>
            ) : null}
          </Button>
          <Button type="submit" size="sm" disabled={isPending}>
            {isPending ? "Aplicando…" : "Aplicar filtros"}
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
          <Field icon={Building2} label="Banco" htmlFor="filter-bankId">
            <Select value={bankId} onValueChange={setBankId}>
              <SelectTrigger id="filter-bankId" className="w-full">
                <SelectValue placeholder="Todos los bancos" />
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

          <Field icon={Wallet} label="Monto" htmlFor="filter-amount" description="Monto exacto en DOP">
            <Input
              id="filter-amount"
              name="amount"
              inputMode="decimal"
              placeholder="Ej: 1500.50"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              aria-describedby="filter-amount-hint"
            />
          </Field>

          <Field icon={CreditCard} label="Moneda" htmlFor="filter-currency">
            <Select value={currency} onValueChange={setCurrency}>
              <SelectTrigger id="filter-currency" className="w-full">
                <SelectValue placeholder="Cualquier moneda" />
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

          <Field icon={Hash} label="Identificador de cuenta" htmlFor="filter-accountFingerprint">
            <Input
              id="filter-accountFingerprint"
              name="accountFingerprint"
              placeholder="cuenta-principal"
              value={accountFingerprint}
              onChange={(event) => setAccountFingerprint(event.target.value)}
            />
          </Field>

          <Field icon={CalendarClock} label="Desde" htmlFor="filter-dateFrom">
            <Input
              id="filter-dateFrom"
              name="dateFrom"
              type="date"
              value={dateFrom ?? ""}
              onChange={(event) => setDateFrom(event.target.value)}
            />
          </Field>

          <Field icon={CalendarClock} label="Hasta" htmlFor="filter-dateTo">
            <Input
              id="filter-dateTo"
              name="dateTo"
              type="date"
              value={dateTo ?? ""}
              onChange={(event) => setDateTo(event.target.value)}
            />
          </Field>

          <Field icon={FileText} label="Estado de revisión" htmlFor="filter-reviewState">
            <Select value={reviewState} onValueChange={setReviewState}>
              <SelectTrigger id="filter-reviewState" className="w-full">
                <SelectValue placeholder="Cualquier estado" />
              </SelectTrigger>
              <SelectContent>
                {REVIEW_STATE_VALUES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {REVIEW_STATE_LABELS[value]}
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
                Limpiar todo
              </Button>
            ) : null}
          </div>
        </div>
      </form>

      {activeChips.length > 0 ? (
        <div
          className="flex flex-wrap items-center gap-1.5 border-t border-border/60 bg-muted/30 px-4 py-2.5"
          aria-label="Filtros activos"
        >
          <span className="mr-auto inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <CircleDot className="h-3 w-3 text-success" aria-hidden />
            {resultCount} {resultCount === 1 ? "resultado" : "resultados"}
          </span>
          {activeChips.map((chip) => (
            <button
              key={chip.key}
              type="button"
              onClick={() => removeFilter(chip.key)}
              aria-label={`Quitar filtro: ${chip.name}: ${chip.value}`}
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
  /** Optional helper text rendered below the control and wired as its describedby target. */
  description?: string;
  children: ReactNode;
}

function Field({ icon: Icon, label, htmlFor, className, description, children }: FieldProps) {
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
      {description ? (
        <p id={`${htmlFor}-hint`} className="text-xs text-muted-foreground">
          {description}
        </p>
      ) : null}
    </div>
  );
}

function toDateInputValue(value: string | Date | undefined): string | undefined {
  if (!value) return undefined;
  // Pure YYYY-MM-DD strings (e.g. straight from the URL) are already valid
  // date-input values — return them as-is so we don't reinterpret them as
  // UTC midnight (which would shift the Santo Domingo day back by one).
  if (typeof value === "string") {
    return value.length >= 10 ? value.slice(0, 10) : undefined;
  }
  if (Number.isNaN(value.getTime())) return undefined;
  // The filters now carry UTC instants bounding a Santo Domingo local day
  // (start for dateFrom, end for dateTo). Derive the input value from the
  // Santo Domingo day key so the control shows the local day the operator
  // actually chose, not the UTC day of the bound instant.
  return getSantoDomingoDayKey(value);
}
