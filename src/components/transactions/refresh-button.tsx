"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { Button } from "../ui/button";

// Operator-facing copy in clear professional Spanish (Dominican banking
// staff). These strings are deliberately generic and never leak run IDs,
// internal error messages, or diagnostic details to the browser.
//
// Polling lifecycle:
//   202 queued  -> informational "requested" toast (ONCE, not a success)
//   succeeded   -> success result toast (12s) + refresh
//                  (count-aware: "no new" vs "imported N" with singular/plural)
//   failed      -> failure result toast (12s) + refresh
//   needs_admin -> admin-action result toast (12s) + refresh
//   unverified  -> could-not-verify result toast (12s) + refresh (404/401/403 mid-poll)
//   timeout     -> still-processing result toast (12s) + refresh (deadline / hung GET)
//
// Terminal results surface as a Sonner toast (longer 12s duration, larger
// text) — NOT an inline banner. An inline banner shifted the Refresh button's
// layout and never auto-dismissed; the toast keeps the button in place and
// fades on its own, matching the existing run-conflict toast pattern.
const USER_SAFE_REFRESH_REQUESTED = "Corrida solicitada. Verificando resultado…";
// succeeded with no new transactions — the worker finished but imported
// nothing; the data on screen is already current. Surfaced as informational,
// NOT as an error, because nothing went wrong.
const USER_SAFE_REFRESH_NO_NEW =
  "No hay nuevas transacciones. La información visible ya está al día.";
// succeeded with exactly one new transaction — Spanish singular form.
const USER_SAFE_REFRESH_IMPORTED_SINGULAR =
  "Actualización completada. Se importó 1 transacción nueva.";
const USER_SAFE_REFRESH_FAILED = "No se pudo completar la actualización. Intente nuevamente.";
const USER_SAFE_REFRESH_NEEDS_ADMIN = "La sesión del banco requiere acción del administrador.";
const USER_SAFE_REFRESH_TIMEOUT = "La corrida sigue procesándose. Actualice nuevamente en unos momentos.";
const USER_SAFE_REFRESH_UNVERIFIED =
  "No se pudo verificar el resultado de la corrida. Actualice nuevamente en unos momentos.";
const USER_SAFE_RUN_CONFLICT = "Ya hay una corrida en proceso. Espere a que termine.";
const USER_SAFE_UNSUPPORTED_BANK = "Banco no soportado para corridas manuales.";
const USER_SAFE_FORBIDDEN = "No tiene permisos para realizar esta acción.";
const USER_SAFE_NETWORK_ERROR =
  "No se pudo conectar con el servidor. Intente nuevamente.";

// Abort the initial POST if the server has not responded within this window.
// Exposed via `timeoutMs` so tests can exercise the abort path quickly.
const DEFAULT_REFRESH_TIMEOUT_MS = 15_000;

// Polling defaults. The client polls the single-run status endpoint until the
// run reaches a terminal state (succeeded/failed/needs_admin_action) or the
// polling deadline elapses. Defaults are conservative — a scrape run can take
// tens of seconds on the worker, so 60s gives it room without hanging forever.
const DEFAULT_POLL_INTERVAL_MS = 1_500;
const DEFAULT_POLL_TIMEOUT_MS = 60_000;

// Terminal refresh results (succeeded / failed / needs_admin_action /
// unverified / timeout) are important enough to stay visible longer than
// Sonner's default toast. Centralized as a named, exported constant so every
// terminal outcome shares one duration and tests can assert on it without
// depending on brittle CSS classes. 12s sits in the approved 10–15s window.
export const REFRESH_RESULT_TOAST_DURATION_MS = 12_000;

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
 * from /transactions and re-render the server component with fresh data ONCE
 * the worker finishes — not the moment the run is merely queued.
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
    // Guard against duplicate clicks while a request/poll is already in
    // flight. The button is also `disabled` during pending, but this guard is
    // the real gate for race conditions that bypass the disabled attribute.
    if (pending) return;
    setPending(true);
    // The terminal result is surfaced as a transient Sonner toast (longer 12s
    // duration, larger text — see `refreshResultToastOptions`) and NOT as an
    // inline banner. An inline banner shifted this button's layout and never
    // auto-dismissed; the toast keeps the button in place and fades on its
    // own, matching the existing run-conflict toast pattern. The
    // `RefreshOutcomeMessage` returned by `refreshTransactions` is therefore
    // intentionally ignored here — the toast already spoke, and there is
    // nothing inline to render.
    void refreshTransactions({
      bankId,
      fetchImpl: fetch,
      // `onRefresh` fires only on terminal states (and timeout), after which a
      // server re-render reflects the freshly imported transactions.
      onRefresh: () => startTransition(() => router.refresh()),
    }).finally(() => {
      setPending(false);
    });
  }

  return (
    <div className="flex flex-col items-start gap-2">
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
    </div>
  );
}

// ---------------------------------------------------------------------------
// Polling helper
// ---------------------------------------------------------------------------

export type PollScrapeRunStatusOutcome =
  | { status: "succeeded"; insertedCount: number }
  | { status: "failed" }
  | { status: "needs_admin_action" }
  | { status: "unverified" }
  | { status: "timeout" };

// ---------------------------------------------------------------------------
// Visible outcome description
//
// `pollScrapeRunStatus` tells us the terminal state (and counts for a
// succeeded run). `describePollOutcome` turns that into a safe, operator-
// facing message plus a tone ("info" | "success" | "error"). The tone is kept
// as part of the pure contract so the Spanish copy (zero vs. singular vs.
// plural) and the tone mapping stay unit-testable without a DOM; the UI now
// surfaces results via a Sonner toast (see `refreshResultToastOptions`) rather
// than an inline banner. Color is never the only signal: Sonner's `richColors`
// theme pairs each toast variant with an icon, and the full Spanish message is
// always present.
// ---------------------------------------------------------------------------

export type RefreshOutcomeTone = "success" | "info" | "error";

export interface RefreshOutcomeMessage {
  message: string;
  tone: RefreshOutcomeTone;
}

/**
 * Map a poll outcome onto a safe, visible message + tone. Exported so tests
 * can pin the Spanish copy (zero vs. singular vs. plural) and tone directly.
 */
export function describePollOutcome(
  outcome: PollScrapeRunStatusOutcome,
): RefreshOutcomeMessage {
  switch (outcome.status) {
    case "succeeded":
      if (outcome.insertedCount <= 0) {
        return { message: USER_SAFE_REFRESH_NO_NEW, tone: "info" };
      }
      return {
        message: describeSucceededImportMessage(outcome.insertedCount),
        tone: "success",
      };
    case "failed":
      return { message: USER_SAFE_REFRESH_FAILED, tone: "error" };
    case "needs_admin_action":
      return { message: USER_SAFE_REFRESH_NEEDS_ADMIN, tone: "error" };
    case "unverified":
      return { message: USER_SAFE_REFRESH_UNVERIFIED, tone: "error" };
    case "timeout":
      return { message: USER_SAFE_REFRESH_TIMEOUT, tone: "error" };
  }
}

/**
 * Build the count-aware "imported N transactions" message with correct
 * Spanish singular/plural. Kept tiny and pure for deterministic tests.
 */
function describeSucceededImportMessage(insertedCount: number): string {
  if (insertedCount === 1) return USER_SAFE_REFRESH_IMPORTED_SINGULAR;
  return `Actualización completada. Se importaron ${insertedCount} transacciones nuevas.`;
}

export interface PollScrapeRunStatusOptions {
  runId: string;
  fetchImpl: typeof fetch;
  /** Milliseconds between status checks. Defaults to 1500ms. */
  pollIntervalMs?: number;
  /** Total polling deadline in milliseconds. Defaults to 60000ms. */
  pollTimeoutMs?: number;
  /**
   * Sleep primitive injected for tests so polling loops run without real
   * delays. Defaults to a real setTimeout-based sleep.
   */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Poll `GET /api/scrape-runs/[runId]` until the run reaches a terminal state
 * (`succeeded` / `failed` / `needs_admin_action`) or the deadline elapses.
 *
 * The first check is delayed by `pollIntervalMs` — the run was JUST created as
 * `queued`, so an immediate poll would almost certainly return `queued` and
 * waste a request.
 *
 * Resilience: transient network errors, 5xx responses, and malformed JSON
 * during a single poll are swallowed and retried (the run record is the source
 * of truth, not any one poll). Only a terminal status or the deadline ends
 * the loop. A 404/401/403 mid-poll returns `unverified` — the run is gone or
 * the session was lost, so we cannot verify the result and should NOT claim it
 * is "still processing"; refreshing the page shows the operator the current
 * state either way.
 *
 * Each poll GET is bounded by the remaining deadline via an AbortController
 * that stays armed across BOTH the fetch (header resolution) AND the response
 * body parse. If the status endpoint hangs — whether at the headers or with a
 * stalled body — the deadline abort fires and we return `timeout` so the
 * button is never disabled forever.
 */
export async function pollScrapeRunStatus({
  runId,
  fetchImpl,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  pollTimeoutMs = DEFAULT_POLL_TIMEOUT_MS,
  sleep = defaultSleep,
}: PollScrapeRunStatusOptions): Promise<PollScrapeRunStatusOutcome> {
  const url = `/api/scrape-runs/${encodeURIComponent(runId)}`;
  const deadline = Date.now() + pollTimeoutMs;

  // Poll loop: every branch that ends polling returns, so the loop only
  // continues while the run is still `queued`/`running`/unknown.
  while (true) {
    await sleep(pollIntervalMs);

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return { status: "timeout" };
    }

    // Bound BOTH the fetch (header resolution) AND the response body parse by
    // the same remaining deadline. The AbortController stays armed until the
    // body has been fully consumed — the timer is only cleared in the
    // `finally` below, which runs on every exit path (return, continue,
    // throw). If the headers arrive but the body stalls, the deadline abort
    // errors the body stream where the fetch implementation ties the stream to
    // the signal, and `withDeadline` rejects otherwise — so a half-received
    // response can never keep the button disabled forever.
    const controller = new AbortController();
    const abortId = setTimeout(() => controller.abort(), remaining);
    try {
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "GET",
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
      } catch (error) {
        // The deadline-abort fired while the fetch was still pending — the
        // status endpoint hung. Surface a safe timeout so the button
        // re-enables and the page can refresh with whatever data is available.
        if (controller.signal.aborted || isAbortError(error)) {
          return { status: "timeout" };
        }
        // Transient network blip — keep polling until the deadline.
        continue;
      }

      // 404: the run is gone. We cannot verify its result — return
      // `unverified` (NOT `timeout`) so the toast does not claim the run is
      // still processing. We do NOT read the body for terminal status codes.
      if (response.status === 404) {
        return { status: "unverified" };
      }

      // 401/403 mid-poll: the session was lost. We cannot verify the run
      // result here — return `unverified` and refresh so the page can handle
      // auth.
      if (response.status === 401 || response.status === 403) {
        return { status: "unverified" };
      }

      // 5xx / other non-200: treat as transient and keep polling.
      if (response.status !== 200) {
        continue;
      }

      // 200: parse the body BOUNDED by the same deadline. `readRunStatusBody`
      // races `response.json()` against the abort signal via `withDeadline`,
      // so even a fetch implementation that does NOT tie the body stream to
      // the signal cannot hang here. A deadline abort during the body read
      // propagates as a timeout; malformed JSON is treated as a transient bad
      // poll.
      let run: SafeScrapeRunStatusBody | undefined;
      try {
        run = await readRunStatusBody(response, controller.signal);
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error)) {
          return { status: "timeout" };
        }
        // Unexpected body-read error — keep polling until the deadline.
        continue;
      }

      const runStatus = run?.status;
      if (runStatus === "succeeded") {
        // The status endpoint projects ONLY safe fields. The visible message
        // only needs `insertedCount` to distinguish "nothing new" from
        // "imported N" — we never surface the run id, error summaries, or
        // diagnostics.
        return {
          status: "succeeded",
          insertedCount: coerceCount(run?.insertedCount),
        };
      }
      if (runStatus === "failed") return { status: "failed" };
      if (runStatus === "needs_admin_action") return { status: "needs_admin_action" };
      // queued / running / unknown — keep polling.
    } finally {
      // Always clear the timer once the fetch + body parse for this poll are
      // done (resolved, rejected, or aborted) so no pending abort leaks into
      // the next iteration or fires after we have already settled.
      clearTimeout(abortId);
    }
  }
}

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException) return error.name === "AbortError";
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Race a promise against an AbortSignal so an operation that never resolves —
 * and is not tied to the signal by its own API (e.g. `Response.prototype.json`
 * takes no signal, and some fetch implementations do not error the body stream
 * on abort) — still breaks out when the signal aborts.
 *
 * If the signal is already aborted, the promise is never awaited and we reject
 * immediately. Otherwise the first of {promise settle, signal abort} wins; the
 * losing branch removes its listener so nothing leaks.
 */
function withDeadline<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(
      new DOMException("The operation was aborted", "AbortError"),
    );
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () =>
      reject(new DOMException("The operation was aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Safe slice of the `GET /api/scrape-runs/[runId]` body that the client is
 * allowed to read. The backend projection exposes only safe fields; this
 * client consumes `status` and `insertedCount` — everything else (run id is already
 * known client-side, error summaries, timestamps, account fingerprints) is
 * stripped server-side. We type only the fields we consume so an accidental
 * extra field in the response is ignored, never displayed.
 */
interface SafeScrapeRunStatusBody {
  status?: string;
  insertedCount?: number;
}

async function readRunStatusBody(
  response: Response,
  signal: AbortSignal,
): Promise<SafeScrapeRunStatusBody | undefined> {
  let body: { run?: SafeScrapeRunStatusBody };
  try {
    // Race the body parse against the poll deadline. `response.json()` does
    // not accept an AbortSignal, and not every fetch implementation ties the
    // body stream to the signal passed to `fetch` — so `withDeadline` is the
    // guarantee that a stalled body breaks out when the deadline aborts.
    body = (await withDeadline(response.json(), signal)) as {
      run?: SafeScrapeRunStatusBody;
    };
  } catch (error) {
    // Propagate deadline aborts so the poll loop can surface a safe timeout —
    // do NOT swallow them as a transient bad poll.
    if (signal.aborted || isAbortError(error)) throw error;
    // Malformed JSON — treat as a transient bad poll and keep going.
    return undefined;
  }
  return body.run;
}

/**
 * Coerce a parsed count into a safe non-negative integer. The backend always
 * sends finite non-negative counts, but the client must never trust parsed
 * JSON blindly: a negative, NaN, or non-number value is treated as 0 so the
 * message can never say "imported NaN transacciones" or similar.
 */
function coerceCount(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Refresh trigger
// ---------------------------------------------------------------------------

interface RefreshTransactionsOptions {
  /**
   * Bank to target. Optional — when omitted the request carries no body and
   * the backend defaults to the supported Popular profile.
   */
  bankId?: string;
  fetchImpl: typeof fetch;
  /**
   * Fires only on terminal states (succeeded/failed/needs_admin_action) and
   * on polling timeout — NOT on the initial 202. Renamed from `onSuccess`
   * because "success" now means "the worker finished", not "the run was
   * queued".
   */
  onRefresh: () => void;
  /**
   * Abort the initial POST after this many milliseconds if the server has not
   * responded. Defaults to 15 seconds. Exposed for tests.
   */
  timeoutMs?: number;
  /** Polling interval in milliseconds. Defaults to 1500ms. */
  pollIntervalMs?: number;
  /** Polling deadline in milliseconds. Defaults to 60000ms. */
  pollTimeoutMs?: number;
  /** Injected sleep for tests so polling loops run without real delays. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Pure refresh trigger logic, extracted for testability without a DOM.
 *
 * Contract:
 * - POSTs to /api/scrape-runs/run-now. Sends no body when `bankId` is
 *   omitted (backend defaults to Popular); otherwise sends `{ bankId }`.
 * - On 202: the run is QUEUED, not finished. Show one informational toast,
 *   extract the run id, and poll the single-run status endpoint until the
 *   run reaches a terminal state (or the polling deadline elapses). Only then
 *   is `onRefresh` (router.refresh) called and a terminal result toast shown
 *   (12s duration, larger text). The terminal `RefreshOutcomeMessage` (safe
 *   Spanish copy + tone) is returned for callers/tests; the UI surfaces it via
 *   the shared result toast, not an inline banner.
 * - On 409 (active run already exists): surfaces a specific safe toast. No
 *   refresh — nothing changed. Returns `null` (no result toast: this is a
 *   gate failure, not a completed run).
 * - On 400 (unsupported bank): surfaces a specific safe toast. No refresh.
 *   Returns `null`.
 * - On 401/403: surfaces a permission toast. No refresh. Returns `null`.
 * - On 503, any other non-2xx, or a thrown network error: surfaces a generic
 *   connection toast and never leaks the raw backend error.message. No
 *   refresh. Returns `null`.
 * - Never surfaces run IDs, internal error text, or diagnostic details.
 */
export async function refreshTransactions({
  bankId,
  fetchImpl,
  onRefresh,
  timeoutMs = DEFAULT_REFRESH_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  pollTimeoutMs = DEFAULT_POLL_TIMEOUT_MS,
  sleep = defaultSleep,
}: RefreshTransactionsOptions): Promise<RefreshOutcomeMessage | null> {
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
      return null;
    }

    if (response.status === 202) {
      // Queued, not finished. Extract the run id and poll until terminal.
      const runId = await extractRunId(response);
      if (!runId) {
        // Defensive: the backend always returns run.runId today. If the shape
        // ever changes we still refresh + surface a safe message so the
        // operator is never left staring at a disabled button forever.
        toast.error(USER_SAFE_NETWORK_ERROR);
        onRefresh();
        return null;
      }

      // One informational toast for the whole poll — not repeated per check.
      toast.info(USER_SAFE_REFRESH_REQUESTED);

      const outcome = await pollScrapeRunStatus({
        runId,
        fetchImpl,
        pollIntervalMs,
        pollTimeoutMs,
        sleep,
      });
      // handlePollOutcome fires the terminal result toast (12s duration),
      // calls onRefresh, and returns the safe visible message for callers/tests.
      return handlePollOutcome(outcome, onRefresh);
    }

    if (response.status === 409) {
      toast.error(USER_SAFE_RUN_CONFLICT);
      return null;
    }

    if (response.status === 400) {
      toast.error(USER_SAFE_UNSUPPORTED_BANK);
      return null;
    }

    if (response.status === 401 || response.status === 403) {
      toast.error(USER_SAFE_FORBIDDEN);
      return null;
    }

    // 503, 500, or any other non-2xx — treat as a generic connection failure.
    toast.error(USER_SAFE_NETWORK_ERROR);
    return null;
  } finally {
    // Always clear the timer so a completed (or failed) request never leaks a
    // pending abort that could fire later.
    clearTimeout(timeoutId);
  }
}

/**
 * Sonner options for a terminal refresh-result toast. Larger text (`text-base
 * font-medium` vs Sonner's default `text-sm`) plus the shared 12s duration
 * make the result clearly visible without an inline banner — which shifted the
 * Refresh button's layout and never auto-dismissed.
 *
 * The `duration` is the stable, testable knob (asserted on directly). The
 * `className` is a non-asserted visual hook: the app's Toaster already enables
 * `richColors`, so success/error/info variants get their own colored chrome
 * and icon — this className only enlarges the message text. Tests never
 * depend on the className, so styling can evolve without breaking them.
 */
export function refreshResultToastOptions(): {
  duration: number;
  className: string;
} {
  return {
    duration: REFRESH_RESULT_TOAST_DURATION_MS,
    className: "rd-sync-refresh-result text-base font-medium leading-relaxed",
  };
}

function handlePollOutcome(
  outcome: PollScrapeRunStatusOutcome,
  onRefresh: () => void,
): RefreshOutcomeMessage {
  const description = describePollOutcome(outcome);
  // Terminal refresh results share one longer-duration result toast so the
  // operator has time to read the outcome. The toast variant follows the
  // outcome tone: no-new-transactions is informational, imported transactions
  // are success, and failure/admin/timeout/unverified states are errors.
  const options = refreshResultToastOptions();
  if (description.tone === "success") {
    toast.success(description.message, options);
  } else if (description.tone === "info") {
    toast.info(description.message, options);
  } else {
    toast.error(description.message, options);
  }
  onRefresh();
  return description;
}

async function extractRunId(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { run?: { runId?: string; id?: string } };
    return body.run?.runId ?? body.run?.id;
  } catch {
    return undefined;
  }
}

export { USER_SAFE_RUN_CONFLICT };
