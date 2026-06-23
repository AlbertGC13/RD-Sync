"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { Button } from "../ui/button";

// Operator-facing copy in clear professional Spanish (Dominican banking
// staff). These strings are deliberately generic and never leak run IDs,
// internal error messages, or diagnostic details to the browser.
const USER_SAFE_REFRESH_SUCCESS =
  "Corrida solicitada. Las transacciones se actualizarán en breve.";
const USER_SAFE_RUN_CONFLICT = "Ya hay una corrida en proceso. Espere a que termine.";
const USER_SAFE_UNSUPPORTED_BANK = "Banco no soportado para corridas manuales.";
const USER_SAFE_FORBIDDEN = "No tiene permisos para realizar esta acción.";
const USER_SAFE_NETWORK_ERROR =
  "No se pudo conectar con el servidor. Intente nuevamente.";

// Abort a manual refresh if the server has not responded within this window.
// Without it a hung backend leaves `pending` true forever — the button stays
// disabled with no toast. Exposed via `timeoutMs` so tests can exercise the
// abort path with a very short value.
const DEFAULT_REFRESH_TIMEOUT_MS = 15_000;

interface RefreshButtonProps {
  /**
   * Bank the new run should target. Omitted on the transactions page so the
   * backend defaults to the Popular profile (the only scraper currently
   * shipping). When omitted the request is sent with NO body.
   */
  bankId?: string;
}

/**
 * RefreshButton lets any authenticated employee trigger a manual scrape run
 * from /transactions and re-render the server component with fresh data.
 *
 * Authorization is enforced on the backend (`requireRole` with every
 * authenticated role). This component is an affordance only — it does NOT
 * decide who can click.
 */
export function RefreshButton({ bankId }: RefreshButtonProps = {}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [, startTransition] = useTransition();

  function handleClick() {
    // Guard against duplicate clicks while a request is already in flight.
    // The button is also `disabled` during pending, but this guard is the
    // real gate for race conditions that bypass the disabled attribute.
    if (pending) return;
    setPending(true);
    void refreshTransactions({
      bankId,
      fetchImpl: fetch,
      onSuccess: () => startTransition(() => router.refresh()),
    }).finally(() => {
      setPending(false);
    });
  }

  return (
    <Button
      onClick={handleClick}
      disabled={pending}
      size="sm"
      variant="outline"
      className="gap-1.5"
      aria-label="Refrescar transacciones"
    >
      <RefreshCw
        className={pending ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"}
        aria-hidden
      />
      {pending ? "Actualizando…" : "Refrescar"}
    </Button>
  );
}

interface RefreshTransactionsOptions {
  /**
   * Bank to target. Optional — when omitted the request carries no body and
   * the backend defaults to the supported Popular profile.
   */
  bankId?: string;
  fetchImpl: typeof fetch;
  onSuccess: () => void;
  /**
   * Abort the request after this many milliseconds if the server has not
   * responded. Defaults to 15 seconds. Exposed primarily for tests so the
   * timeout path can be exercised with a very short value.
   */
  timeoutMs?: number;
}

/**
 * Pure refresh trigger logic, extracted for testability without a DOM.
 *
 * Contract:
 * - POSTs to /api/scrape-runs/run-now. Sends no body when `bankId` is
 *   omitted (backend defaults to Popular); otherwise sends `{ bankId }`.
 * - On 202: fires a success toast and calls `onSuccess` (router.refresh()).
 * - On 409 (active run already exists): surfaces a specific safe toast so
 *   the operator understands the run was not duplicated.
 * - On 400 (unsupported bank): surfaces a specific safe toast.
 * - On 401/403: surfaces a permission toast.
 * - On 503, any other non-2xx, or a thrown network error: surfaces a
 *   generic connection toast and never leaks the raw backend error.message.
 * - Never surfaces run IDs, internal error text, or diagnostic details.
 */
export async function refreshTransactions({
  bankId,
  fetchImpl,
  onSuccess,
  timeoutMs = DEFAULT_REFRESH_TIMEOUT_MS,
}: RefreshTransactionsOptions): Promise<void> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let response: Response;
    try {
      response = await fetchImpl("/api/scrape-runs/run-now", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: bankId ? JSON.stringify({ bankId }) : undefined,
        signal: controller.signal,
      });
    } catch {
      // Covers both a thrown network error AND an abort fired by the timeout
      // above (a hung backend). Both surface the same safe connection toast —
      // we never leak the raw error to the browser.
      toast.error(USER_SAFE_NETWORK_ERROR);
      return;
    }

    if (response.status === 202) {
      toast.success(USER_SAFE_REFRESH_SUCCESS);
      onSuccess();
      return;
    }

    if (response.status === 409) {
      toast.error(USER_SAFE_RUN_CONFLICT);
      return;
    }

    if (response.status === 400) {
      toast.error(USER_SAFE_UNSUPPORTED_BANK);
      return;
    }

    if (response.status === 401 || response.status === 403) {
      toast.error(USER_SAFE_FORBIDDEN);
      return;
    }

    // 503, 500, or any other non-2xx — treat as a generic connection failure.
    toast.error(USER_SAFE_NETWORK_ERROR);
  } finally {
    // Always clear the timer so a completed (or failed) request never leaks a
    // pending abort that could fire later.
    clearTimeout(timeoutId);
  }
}

export { USER_SAFE_RUN_CONFLICT };
