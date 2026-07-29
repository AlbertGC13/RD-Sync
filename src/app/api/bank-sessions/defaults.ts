/**
 * Default wiring for the bank-sessions API.
 *
 * Env vars are read at IMPORT TIME (module-level), not per-request, mirroring
 * the pattern used by consumer-defaults.ts.  Restart the Next.js dev server
 * after changing any env var below.
 *
 * Relevant env vars:
 *   RD_SYNC_SCRAPER            — "popular-cdp" enables the CDP-backed checker
 *   RD_SYNC_BANK_POPULAR_CDP_URL — Popular CDP endpoint (fallback RD_SYNC_CDP_URL)
 *   RD_SYNC_SESSION_CHECK_INTERVAL_MS — poll interval in ms (default 300000, min 60000)
 */

import {
  createCdpSessionChecker,
  type CdpSessionChecker,
  type BankSessionCheckResult,
  type BankSessionMonitor,
} from "../../../modules/bank-sessions";
import { popularBankCode } from "../../../modules/bank-adapters/popular";
import { resolveBankBrowserEnv } from "../../../worker/scraper/browser-runtime";

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
    const bankEnv = resolveBankBrowserEnv(popularBankCode);
    return createCdpSessionChecker({
      cdpUrl: bankEnv.cdpUrl || undefined,
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

/**
 * The API process has no always-on lifecycle owner. Keeping this producer
 * dormant prevents status-route traffic from becoming production scheduling.
 * A dedicated worker bootstrap must own activation before this can be enabled.
 */
export function resolveDefaultSessionMonitor(): BankSessionMonitor | null {
  return null;
}

// ---------------------------------------------------------------------------
// globalThis checker anchor
// ---------------------------------------------------------------------------

const globalRegistry = globalThis as typeof globalThis & {
  __rdSyncSessionChecker?: CdpSessionChecker;
};

const defaultSessionChecker =
  (globalRegistry.__rdSyncSessionChecker ??= resolveDefaultSessionChecker());

const defaultSessionMonitor = resolveDefaultSessionMonitor();

export { defaultSessionChecker, defaultSessionMonitor };
