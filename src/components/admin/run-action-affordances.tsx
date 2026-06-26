"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "../ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../ui/tooltip";
import { notImplemented } from "../../app/(private)/transactions/_actions/not-implemented";
import type { ScrapeRunStatus } from "../../worker/queues";
import {
  bankDisplayName,
  isSupportedRunNowBankCode,
  SUPPORTED_RUN_NOW_BANK_CODES,
  scrapeRunStatusLabel,
} from "../../lib/banks";

interface RunActionAffordancesProps {
  runId: string;
  bankId: string;
  status: ScrapeRunStatus;
}

// User-safe fallback. The backend already returns a generic message on errors,
// but we still need a fallback for the rare case the response has no body.
export const USER_SAFE_RUN_FAILURE = "No se pudo programar la corrida. Inténtalo nuevamente.";

const UNSUPPORTED_BANK_MESSAGE = "Este banco aún no está disponible para corridas manuales.";
const USER_SAFE_RUN_CONFLICT = "Ya hay una corrida activa para este banco. Espera a que finalice.";

// Re-export the shared label/bank helpers so consumers that import from this
// module keep working. The single source of truth lives in `src/lib/banks.ts`.
export { bankDisplayName, scrapeRunStatusLabel, SUPPORTED_RUN_NOW_BANK_CODES };

/**
 * Pure per-card run-now trigger, extracted for testability without a DOM.
 *
 * Contract:
 * - Refuses to send a request for a bank that is NOT in the supported list,
 *   so the UI never claims a run was queued for an unsupported bank.
 * - Always sends `Content-Type: application/json` with a `{ bankId }` body.
 * - On any non-2xx response or thrown error, surfaces a generic user-safe
 *   toast and never leaks the raw backend error.message.
 * - On 2xx, fires a bank-specific success toast (using the operator-facing
 *   display name, never the raw bankId) and calls `onSuccess`
 *   (router.refresh()).
 */
export async function triggerRunNowForBank({
  bankId,
  fetchImpl,
  onSuccess,
}: {
  bankId: string;
  fetchImpl: typeof fetch;
  onSuccess: () => void;
}): Promise<void> {
  if (!isSupportedRunNowBankCode(bankId)) {
    // Never claim success for an unsupported bank — refuse up front.
    toast.error(UNSUPPORTED_BANK_MESSAGE);
    return;
  }

  let response: Response;
  try {
    response = await fetchImpl("/api/scrape-runs/run-now", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bankId }),
    });
  } catch {
    toast.error(USER_SAFE_RUN_FAILURE);
    return;
  }

  if (response.status === 409) {
    toast.error(USER_SAFE_RUN_CONFLICT);
    return;
  }

  if (!response.ok) {
    toast.error(USER_SAFE_RUN_FAILURE);
    return;
  }

  toast.success(`Nueva corrida de ${bankDisplayName(bankId)} en cola — procesándose.`);
  onSuccess();
}

/**
 * Factory for the per-card "Ejecutar ahora" click handler. Extracted so the
 * in-flight pending guard is unit-testable without a DOM.
 *
 * Contract:
 * - If the bank is unsupported, surface the explicit toast and return.
 * - If a request is already in flight (`isPending === true`), do nothing —
 *   this is the local guard against rapid double-clicks that would otherwise
 *   queue two runs before router.refresh() lands.
 * - Otherwise, flip `setPending(true)`, fire the request, then release the
 *   guard in finally().
 */
export function createRunNowClickHandler({
  bankId,
  isSupportedBank,
  isPending,
  setPending,
  fetchImpl,
  onSuccess,
}: {
  bankId: string;
  isSupportedBank: boolean;
  isPending: boolean;
  setPending: (value: boolean) => void;
  fetchImpl: typeof fetch;
  onSuccess: () => void;
}): () => void {
  return function handleClick() {
    if (!isSupportedBank) {
      // Defensive: the disabled button + tooltip already make this obvious,
      // but a programmatic click path must never queue misleading work.
      toast.error(UNSUPPORTED_BANK_MESSAGE);
      return;
    }
    if (isPending) {
      // In-flight guard: a previous click already started a request. Don't
      // queue another one until the existing one resolves.
      return;
    }
    setPending(true);
    void triggerRunNowForBank({
      bankId,
      fetchImpl,
      onSuccess,
    }).finally(() => {
      setPending(false);
    });
  };
}

/**
 * FR-012 run action affordances for admin scrape runs.
 *
 * Run now is wired to the PR4 endpoint. Disable and Renew remain
 * honest stubs until session management lands.
 */
export function RunActionAffordances({ runId, bankId, status }: RunActionAffordancesProps) {
  const router = useRouter();
  const [runNowPending, setRunNowPending] = useState(false);
  const isSupportedBank = isSupportedRunNowBankCode(bankId);
  // Triple-belt: bank-unsupported OR a request is in flight OR the run is
  // already processing locally.
  const isRunNowDisabled = !isSupportedBank || runNowPending || status === "running" || status === "queued";

  function handleDeferredClick(feature: "disable" | "renew") {
    void (async () => {
      const result = await notImplemented({ feature });
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      toast.success(`Corrida ${runId} ${feature}`);
    })();
  }

  function handleRunNowClick() {
    // Local in-flight guard lives inside createRunNowClickHandler so the
    // behaviour can be unit-tested without a DOM.
    return createRunNowClickHandler({
      bankId,
      isSupportedBank,
      isPending: runNowPending,
      setPending: setRunNowPending,
      fetchImpl: fetch,
      onSuccess: () => router.refresh(),
    })();
  }

  return (
    <TooltipProvider delayDuration={150}>
      <div
        className="flex flex-wrap gap-2 border-t border-border pt-3"
        role="group"
        aria-label="Acciones de corrida"
      >
        <ActionButton
          label={runNowPending ? "En cola…" : "Ejecutar ahora"}
          tooltip={
            isSupportedBank
              ? "Programar una nueva corrida de extracción ahora"
              : "Este banco aún no está disponible para corridas manuales"
          }
          onClick={handleRunNowClick}
          disabled={isRunNowDisabled}
          aria-disabled={isRunNowDisabled ? "true" : undefined}
          aria-label={
            isSupportedBank
              ? "Programar una nueva corrida de extracción ahora"
              : "Banco no soportado para corridas manuales"
          }
          data-action="run-now"
        />
        <ActionButton
          label="Desactivar conexión"
          tooltip="Disponible cuando se conecte la gestión de sesiones"
          onClick={() => handleDeferredClick("disable")}
          disabled
          aria-disabled="true"
          data-action="disable"
        />
        <ActionButton
          label="Renovar sesión"
          tooltip="Disponible cuando se conecte la gestión de sesiones"
          onClick={() => handleDeferredClick("renew")}
          disabled
          aria-disabled="true"
          data-action="renew"
        />
        <span className="ml-auto text-xs text-muted-foreground" aria-live="polite">
          Estado actual: {scrapeRunStatusLabel(status)}
        </span>
      </div>
    </TooltipProvider>
  );
}

interface ActionButtonProps {
  label: string;
  tooltip: string;
  onClick: () => void;
  disabled?: boolean;
  "aria-disabled"?: "true";
  "aria-label"?: string;
  "data-action": string;
}

function ActionButton({ label, tooltip, onClick, disabled, ...rest }: ActionButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={onClick}
          className={disabled ? "opacity-60" : undefined}
          {...rest}
        >
          {label}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        <p>{tooltip}</p>
      </TooltipContent>
    </Tooltip>
  );
}
