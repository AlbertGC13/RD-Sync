/**
 * Default wiring for the bank-sessions API.
 *
 * Env vars are read at IMPORT TIME (module-level), not per-request, mirroring
 * the pattern used by consumer-defaults.ts.  Restart the Next.js dev server
 * after changing any env var below.
 *
 * Relevant env vars:
 *   RD_SYNC_SCRAPER            — "popular-cdp" enables the CDP-backed checker
 *   RD_SYNC_CDP_URL            — CDP endpoint (default http://127.0.0.1:9222)
 *   RD_SYNC_SESSION_MONITOR    — "enabled" activates the background monitor
 *   RD_SYNC_SESSION_CHECK_INTERVAL_MS — poll interval in ms (default 300000, min 60000)
 */

import {
  createCdpSessionChecker,
  createBankSessionMonitor,
  type CdpSessionChecker,
  type BankSessionCheckResult,
  type BankSessionMonitor,
} from "../../../modules/bank-sessions";
import { resolveDefaultAlertSink } from "../../../worker/alerts/email-alert-sink";
import { defaultAuditSink } from "../audit/defaults";

// ---------------------------------------------------------------------------
// resolveDefaultSessionChecker
// ---------------------------------------------------------------------------

/**
 * Returns a session checker based on the current env configuration.
 * - RD_SYNC_SCRAPER === "popular-cdp" → real CDP-backed checker
 * - Otherwise → stub that always reports browser_unavailable (safe default)
 *
 * NOTE: the session checker deliberately does NOT auto-launch the bank
 * browser. Launching is a side effect reserved for the worker/scraper path
 * (actual scrape runs). A read-only status check should only REPORT the
 * current state — if the browser is down it returns browser_unavailable so
 * the admin knows to start it, rather than silently spawning processes from
 * a status endpoint.
 */
export function resolveDefaultSessionChecker(): CdpSessionChecker {
  if (process.env.RD_SYNC_SCRAPER === "popular-cdp") {
    return createCdpSessionChecker({
      cdpUrl: process.env.RD_SYNC_CDP_URL,
    });
  }

  // Stub: safe default when scraper is not configured.
  return {
    async check(): Promise<BankSessionCheckResult> {
      return {
        status: "browser_unavailable",
        checkedAt: new Date().toISOString(),
        safeSummary: "Bank browser session is not available",
      };
    },
  };
}

// ---------------------------------------------------------------------------
// resolveDefaultSessionMonitor
// ---------------------------------------------------------------------------

const MIN_INTERVAL_MS = 60_000;
const DEFAULT_INTERVAL_MS = 300_000;

function resolveIntervalMs(): number {
  const raw = process.env.RD_SYNC_SESSION_CHECK_INTERVAL_MS;
  if (!raw) return DEFAULT_INTERVAL_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_INTERVAL_MS;
  return Math.max(parsed, MIN_INTERVAL_MS);
}

/**
 * Returns a bank session monitor wired with the default checker, alert sink,
 * and audit sink — or null when RD_SYNC_SESSION_MONITOR !== "enabled".
 */
export function resolveDefaultSessionMonitor(): BankSessionMonitor | null {
  if (process.env.RD_SYNC_SESSION_MONITOR !== "enabled") {
    return null;
  }

  return createBankSessionMonitor({
    check: () => defaultSessionChecker.check(),
    alertSink: resolveDefaultAlertSink(),
    auditSink: defaultAuditSink,
    intervalMs: resolveIntervalMs(),
  });
}

// ---------------------------------------------------------------------------
// globalThis anchors
//
// Both the checker and the monitor are anchored on globalThis so every Next.js
// module graph (RSC page, API route handler) shares a single instance.
// Anchoring the monitor prevents two separate setInterval timers being started
// when Turbopack creates multiple module graphs in dev.
// ---------------------------------------------------------------------------

const globalRegistry = globalThis as typeof globalThis & {
  __rdSyncSessionChecker?: CdpSessionChecker;
  __rdSyncSessionMonitor?: BankSessionMonitor | null;
};

const defaultSessionChecker =
  (globalRegistry.__rdSyncSessionChecker ??= resolveDefaultSessionChecker());

// Use a sentinel to distinguish "not yet initialised" from "null (disabled)".
if (!("__rdSyncSessionMonitor" in globalRegistry)) {
  globalRegistry.__rdSyncSessionMonitor = resolveDefaultSessionMonitor();
}
const defaultSessionMonitor = globalRegistry.__rdSyncSessionMonitor ?? null;

// ---------------------------------------------------------------------------
// startDefaultSessionMonitorIfEnabled
//
// Call from the route module to start the background monitor on first import.
// Idempotent — BankSessionMonitor.start() is already idempotent (internal
// handle guard), and the monitor itself is now a global singleton so multiple
// call sites all reach the same instance.
// ---------------------------------------------------------------------------

export function startDefaultSessionMonitorIfEnabled(): void {
  defaultSessionMonitor?.start();
}

export { defaultSessionChecker, defaultSessionMonitor };
