/**
 * Bank adapter registry — runtime composition keyed by `bankCode`
 * (`Bank.code`, the immutable domain code). It registers each bank's scraper
 * factory and injectable auto-login strategy for server-side resolution.
 *
 * `Bank.id` (cuid) remains the internal DB PK for existing relations
 * (`ScrapeRun`); `Bank.code` is the canonical adapter/job/API/credential
 * identity. Adapters are registered by `bankCode` and resolved by `bankCode`.
 *
 */

import type { IngestionScraper } from "../../worker/queues";
import {
  createPopularCdpScraper,
  type PopularCdpScraperOptions,
} from "../../worker/scraper/navigation/popular-cdp";
import {
  createEnsureBrowserForBank,
  createAcquireBrowserSlotFromEnv,
  resolveBankBrowserEnv,
  type EnsureBrowserSeam,
} from "../../worker/scraper/browser-runtime";
import {
  createBankAutoLoginStrategy,
  type BankAutoLoginStrategy as RuntimeBankAutoLoginStrategy,
} from "../../worker/scraper/auto-login";
import {
  createPopularBankAdapter,
  parsePopularTransactionRows,
  popularBankCode,
  popularPortalFixture,
} from "./popular";
import { popularPortalConfig } from "./popular-portal";

export type BankAutoLoginStrategy = RuntimeBankAutoLoginStrategy;

/**
 * A bank adapter. Each bank exposes its canonical `bankCode` plus the
 * factories the runtime needs. `createScraper` produces the read-only
 * `IngestionScraper`; `createAutoLoginStrategy` is injected at server wiring.
 */
export interface BankAdapter {
  /** Canonical immutable domain code (`Bank.code`), e.g. `popular`. */
  readonly bankCode: string;
  /** Builds the read-only ingestion scraper for this bank. */
  createScraper(): IngestionScraper;
  /** Builds the bank-specific credential-mutation strategy. */
  createAutoLoginStrategy(): BankAutoLoginStrategy;
}

/**
 * Registry of bank adapters keyed by `bankCode`. Routing and run-now
 * validation resolve adapters through this surface so an explicit unknown
 * `bankCode` fails closed instead of falling back to Popular.
 */
export interface BankAdapterRegistry {
  /** Returns the adapter for `bankCode`, or `undefined` when none is registered. */
  get(bankCode: string): BankAdapter | undefined;
  /** Canonical list of registered bank codes (derived from registered adapters). */
  supportedBankCodes(): readonly string[];
}

/**
 * Fail-closed guard against two registered banks resolving to the SAME loopback
 * CDP port (MEDIUM-2). A shared CDP endpoint would let the worker attach to the
 * wrong bank's authenticated session once a second bank is registered. Only
 * EXPLICITLY configured endpoints are compared — a bank with no per-bank URL and
 * no global `RD_SYNC_CDP_URL` resolves to "" here and falls back to the shared
 * `DEFAULT_CDP_URL` at scraper construction; comparing those would wrongly flag
 * unconfigured banks. The global `RD_SYNC_CDP_URL` fallback IS compared, because
 * two banks both inheriting one global URL is exactly the collision to catch.
 *
 * Throws a server-side-only error (registry build runs at import/startup, never
 * inside a request) so the message never reaches a browser response.
 */
function assertDistinctBankCdpEndpoints(
  adapters: readonly BankAdapter[],
  env: Record<string, string | undefined>,
): void {
  const portToBankCode = new Map<string, string>();
  for (const adapter of adapters) {
    const cdpUrl = resolveBankBrowserEnv(adapter.bankCode, env).cdpUrl;
    if (!cdpUrl) {
      continue;
    }

    let port: string;
    try {
      port = new URL(cdpUrl).port;
    } catch {
      // Malformed CDP URLs are rejected later by assertCdpLoopback on the
      // connect/launch path; the uniqueness guard stays focused on collisions.
      continue;
    }

    const owner = portToBankCode.get(port);
    if (owner) {
      throw new Error(
        `Bank adapter CDP endpoint collision: "${adapter.bankCode}" and "${owner}" ` +
          `both resolve to loopback CDP port ${port}. Each registered bank must use a ` +
          `distinct loopback CDP URL/port (RD_SYNC_BANK_<BANK>_CDP_URL); the global ` +
          `RD_SYNC_CDP_URL fallback is single-bank-only.`,
      );
    }
    portToBankCode.set(port, adapter.bankCode);
  }
}

/**
 * Builds a `BankAdapterRegistry` from an explicit adapter list. The supported
 * codes are derived from the registered adapters' `bankCode` values — there is
 * no separate whitelist to drift out of sync.
 *
 * At build time it fails closed if two registered banks resolve to the same
 * loopback CDP port (MEDIUM-2 cross-bank session attach guard).
 */
export function createBankAdapterRegistry(
  adapters: readonly BankAdapter[],
  env: Record<string, string | undefined> = process.env,
): BankAdapterRegistry {
  assertDistinctBankCdpEndpoints(adapters, env);

  const byCode = new Map<string, BankAdapter>();
  for (const adapter of adapters) {
    byCode.set(adapter.bankCode, adapter);
  }

  return {
    get(bankCode: string): BankAdapter | undefined {
      return byCode.get(bankCode);
    },
    supportedBankCodes(): readonly string[] {
      return Array.from(byCode.keys());
    },
  };
}

// ---------------------------------------------------------------------------
// Popular scraper factory + default registry instance (server wiring).
//
// The env-based scraper construction previously lived inline in
// `consumer-defaults.resolveDefaultScraper`. It is relocated here so the
// registry owns adapter wiring and `resolveDefaultScraper` becomes a thin
// bankCode router. Behaviour is preserved exactly: popular-cdp takes
// precedence, then the dev-preview fixture, then a needs_admin_action stub.
// ---------------------------------------------------------------------------

/**
 * Builds the Popular CDP scraper options from the given env. Pure and
 * testable — it never touches process.env directly when env is injected.
 *
 * Returns `undefined` when the popular-cdp scraper is not selected, so callers
 * can fall through to the other branches. The `ensureBrowser` seam is included
 * only when `RD_SYNC_BANK_BROWSER_AUTO_LAUNCH=enabled` and the bank-aware CDP
 * URL resolves; otherwise it is `undefined` and the scraper connects directly
 * as before (backward compatible).
 */
export function buildPopularCdpScraperOptionsFromEnv(
  env: Record<string, string | undefined> = process.env,
): PopularCdpScraperOptions | undefined {
  if (env.RD_SYNC_SCRAPER !== "popular-cdp") {
    return undefined;
  }

  const bankEnv = resolveBankBrowserEnv(popularBankCode, env);
  const ensureBrowser: EnsureBrowserSeam | undefined = createEnsureBrowserForBank(
    popularBankCode,
    env,
  );
  return {
    cdpUrl: bankEnv.cdpUrl || undefined,
    ensureBrowser,
    acquireBrowserSlot: createAcquireBrowserSlotFromEnv(env),
  };
}

/**
 * Constructs the Popular read-only ingestion scraper from env read at call
 * time (lazy — no env read at module import). Mirrors the previous
 * `resolveDefaultScraper` branch order exactly so Popular behaviour is
 * unchanged:
 * - RD_SYNC_SCRAPER=popular-cdp -> CDP-attach scraper.
 * - RD_SYNC_DEV_PREVIEW=enabled -> fixture-backed scraper.
 * - Otherwise -> stub that reports needs_admin_action (production never
 *   fabricates data while real bank navigation is not configured).
 */
export function createPopularScraperFromEnv(
  env: Record<string, string | undefined> = process.env,
): IngestionScraper {
  const popularOptions = buildPopularCdpScraperOptionsFromEnv(env);
  if (popularOptions) {
    // Only the worker/scraper path launches the browser — the read-only
    // session checker never does. The ensureBrowser seam (when present) is
    // built from env by buildPopularCdpScraperOptionsFromEnv.
    return createPopularCdpScraper(popularOptions);
  }

  if (env.RD_SYNC_DEV_PREVIEW === "enabled") {
    return {
      collect: async () => ({
        status: "collected" as const,
        movements: parsePopularTransactionRows(popularPortalFixture.transactions),
      }),
    };
  }

  return {
    collect: async () => ({
      status: "needs_admin_action" as const,
      movements: [],
      safeErrorSummary: "Bank portal navigation not configured yet",
    }),
  };
}

const popularAdapter: BankAdapter = createPopularBankAdapter({
  createScraper: () => createPopularScraperFromEnv(),
  createAutoLoginStrategy: () => createBankAutoLoginStrategy(popularPortalConfig, {
    supportedBankCodes: [popularBankCode],
  }),
});

// This composition makes the Popular strategy usable when a caller supplies
// its page seam; registry construction does not execute it. Production
// execution remains dormant: the opener is unavailable by default and
// auto-launch is default-off. Event-source activation is deferred to PR4.5g/4.6.

/**
 * Default bank adapter registry. Routing and run-now validation resolve through
 * this instance so an explicit unknown `bankCode` fails closed.
 */
export const bankAdapterRegistry: BankAdapterRegistry = createBankAdapterRegistry([
  popularAdapter,
]);

// Re-export the canonical Popular code alongside the registry for convenience.
export { popularBankCode };
