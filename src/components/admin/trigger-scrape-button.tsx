"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Play } from "lucide-react";
import { toast } from "sonner";

import { Button } from "../ui/button";
import {
  DEFAULT_RUN_NOW_BANK_CODE,
  isSupportedRunNowBankCode,
  SUPPORTED_RUN_NOW_BANK_CODES,
  type SupportedRunNowBankCode,
} from "../../lib/banks";

// Re-export the shared whitelist so existing imports from this module keep
// working while the single source of truth lives in `src/lib/banks.ts`.
export {
  DEFAULT_RUN_NOW_BANK_CODE,
  isSupportedRunNowBankCode,
  SUPPORTED_RUN_NOW_BANK_CODES,
  type SupportedRunNowBankCode,
};

interface TriggerScrapeButtonProps {
  /**
   * Bank the new run should target. The page-level "Run now" trigger is not
   * attached to a specific card, so it falls back to the Popular profile (the
   * only scraper currently shipping). Per-row affordances should always pass
   * the card's `bankId` explicitly.
   */
  bankId?: string;
  /**
   * Reflects an externally-computed disabled state — e.g. when the page
   * already knows there is an active (queued/running) run for the target
   * bank. Keeps the page-level button honest without a round trip.
   */
  disabled?: boolean;
}

const USER_SAFE_RUN_FAILURE = "No se pudo programar la corrida. Inténtalo nuevamente.";
const USER_SAFE_RUN_CONFLICT = "Ya hay una corrida activa para este banco. Espera a que finalice.";

export function TriggerScrapeButton({
  bankId = DEFAULT_RUN_NOW_BANK_CODE,
  disabled = false,
}: TriggerScrapeButtonProps = {}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const isDisabled = disabled || pending;

  function handleClick() {
    if (isDisabled) return;
    setPending(true);
    void triggerRunNow({ bankId, fetchImpl: fetch, onSuccess: () => router.refresh() }).finally(() => {
      setPending(false);
    });
  }

  return (
    <Button
      onClick={handleClick}
      disabled={isDisabled}
      size="sm"
      className="gap-1.5"
      aria-label="Programar una nueva corrida de extracción ahora"
    >
      <Play className="h-3.5 w-3.5" aria-hidden />
      {pending ? "En cola…" : "Ejecutar ahora"}
    </Button>
  );
}

interface TriggerRunNowOptions {
  /**
   * Bank to target. Optional — defaults to the supported Popular profile so
   * the page-level "Run now" button always posts a valid bankId even when
   * no card is selected.
   */
  bankId?: string;
  fetchImpl: typeof fetch;
  onSuccess: () => void;
}

/**
 * Pure trigger logic, extracted for testability without a DOM.
 *
 * Contract:
 * - Always sends `Content-Type: application/json` with a `{ bankId }` body.
 * - On 409 (active run already exists), surfaces a specific safe toast so the
 *   operator understands the run was not duplicated — distinct from a generic
 *   failure.
 * - On any other non-2xx response or thrown error, surfaces a generic
 *   user-safe toast and never leaks the raw backend error.message.
 * - On 2xx, fires a success toast and calls `onSuccess` (router.refresh()).
 */
export async function triggerRunNow({
  bankId,
  fetchImpl,
  onSuccess,
}: TriggerRunNowOptions): Promise<void> {
  const effectiveBankId = bankId ?? DEFAULT_RUN_NOW_BANK_CODE;

  let response: Response;
  try {
    response = await fetchImpl("/api/scrape-runs/run-now", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bankId: effectiveBankId }),
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

  toast.success("Nueva corrida en cola — procesándose.");
  onSuccess();
}

export { USER_SAFE_RUN_CONFLICT };
