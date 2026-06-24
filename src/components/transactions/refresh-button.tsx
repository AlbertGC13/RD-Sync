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
//   succeeded   -> success toast + refresh
//   failed      -> failure toast + refresh
//   needs_admin -> admin-action toast + refresh
//   unverified  -> could-not-verify toast + refresh (404/401/403 mid-poll)
//   timeout     -> still-processing toast + refresh (deadline / hung GET)
const USER_SAFE_REFRESH_REQUESTED = "Corrida solicitada. Verificando resultado…";
const USER_SAFE_REFRESH_SUCCEEDED = "Transacciones actualizadas.";
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

// ---------------------------------------------------------------------------
// Polling helper
// ---------------------------------------------------------------------------

export type PollScrapeRunStatusOutcome =
  | { status: "succeeded" }
  | { status: "failed" }
  | { status: "needs_admin_action" }
  | { status: "unverified" }
  | { status: "timeout" };

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

      // 200: parse the body BOUNDED by the same deadline. `readRunStatus`
      // races `response.json()` against the abort signal via `withDeadline`,
      // so even a fetch implementation that does NOT tie the body stream to
      // the signal cannot hang here. A deadline abort during the body read
      // propagates as a timeout; malformed JSON is treated as a transient bad
      // poll.
      let status: string | undefined;
      try {
        status = await readRunStatus(response, controller.signal);
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error)) {
          return { status: "timeout" };
        }
        // Unexpected body-read error — keep polling until the deadline.
        continue;
      }

      if (status === "succeeded") return { status: "succeeded" };
      if (status === "failed") return { status: "failed" };
      if (status === "needs_admin_action") return { status: "needs_admin_action" };
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

async function readRunStatus(
  response: Response,
  signal: AbortSignal,
): Promise<string | undefined> {
  let body: { run?: { status?: string } };
  try {
    // Race the body parse against the poll deadline. `response.json()` does
    // not accept an AbortSignal, and not every fetch implementation ties the
    // body stream to the signal passed to `fetch` — so `withDeadline` is the
    // guarantee that a stalled body breaks out when the deadline aborts.
    body = (await withDeadline(response.json(), signal)) as {
      run?: { status?: string };
    };
  } catch (error) {
    // Propagate deadline aborts so the poll loop can surface a safe timeout —
    // do NOT swallow them as a transient bad poll.
    if (signal.aborted || isAbortError(error)) throw error;
    // Malformed JSON — treat as a transient bad poll and keep going.
    return undefined;
  }
  return body.run?.status;
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
 *   is `onRefresh` (router.refresh) called and a terminal toast shown.
 * - On 409 (active run already exists): surfaces a specific safe toast. No
 *   refresh — nothing changed.
 * - On 400 (unsupported bank): surfaces a specific safe toast. No refresh.
 * - On 401/403: surfaces a permission toast. No refresh.
 * - On 503, any other non-2xx, or a thrown network error: surfaces a generic
 *   connection toast and never leaks the raw backend error.message. No refresh.
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
      // Queued, not finished. Extract the run id and poll until terminal.
      const runId = await extractRunId(response);
      if (!runId) {
        // Defensive: the backend always returns run.runId today. If the shape
        // ever changes we still refresh + surface a safe message so the
        // operator is never left staring at a disabled button forever.
        toast.error(USER_SAFE_NETWORK_ERROR);
        onRefresh();
        return;
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
      handlePollOutcome(outcome, onRefresh);
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

function handlePollOutcome(
  outcome: PollScrapeRunStatusOutcome,
  onRefresh: () => void,
): void {
  switch (outcome.status) {
    case "succeeded":
      toast.success(USER_SAFE_REFRESH_SUCCEEDED);
      onRefresh();
      return;
    case "failed":
      toast.error(USER_SAFE_REFRESH_FAILED);
      onRefresh();
      return;
    case "needs_admin_action":
      toast.error(USER_SAFE_REFRESH_NEEDS_ADMIN);
      onRefresh();
      return;
    case "unverified":
      toast.error(USER_SAFE_REFRESH_UNVERIFIED);
      onRefresh();
      return;
    case "timeout":
      toast.error(USER_SAFE_REFRESH_TIMEOUT);
      onRefresh();
      return;
  }
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
