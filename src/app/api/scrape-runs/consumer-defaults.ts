import { popularPortalFixture, parsePopularTransactionRows } from "../../../modules/bank-adapters/popular";
import { createIngestionProcessor } from "../../../worker/queues";
import type { IngestionScraper } from "../../../worker/queues";
import { createInMemoryIngestionConsumer, type InMemoryIngestionConsumer } from "../../../worker/ingestion-consumer";
import { resolveDefaultAlertSink } from "../../../worker/alerts/email-alert-sink";
import { createPopularCdpScraper } from "../../../worker/scraper/navigation/popular-cdp";
import { defaultAuditSink } from "../audit/defaults";
import { defaultTransactionRepository } from "../transactions/defaults";
import { defaultIngestionQueue, defaultScrapeRunRepository } from "./defaults";

const globalRegistry = globalThis as typeof globalThis & {
  __rdSyncIngestionConsumer?: InMemoryIngestionConsumer;
};

/**
 * Resolves the default IngestionScraper based on env vars read at call time.
 *
 * Note: this function is also called once at module-load time (line below) to
 * construct the module-level `defaultProcessor`. Env vars are therefore read at
 * import time for that instance, not lazily per request.
 *
 * - RD_SYNC_SCRAPER=popular-cdp → CDP-attach scraper (Via B: attaches to
 *   a human-opened Brave session; cdpUrl from RD_SYNC_CDP_URL).
 * - RD_SYNC_DEV_PREVIEW=enabled → fixture-backed scraper (Popular portal fixture).
 * - Otherwise → stub that reports needs_admin_action so production never
 *   fabricates data while real bank navigation is not configured.
 */
export function resolveDefaultScraper(): IngestionScraper {
  if (process.env.RD_SYNC_SCRAPER === "popular-cdp") {
    return createPopularCdpScraper({
      cdpUrl: process.env.RD_SYNC_CDP_URL,
    });
  }

  if (process.env.RD_SYNC_DEV_PREVIEW === "enabled") {
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

function createDefaultIngestionConsumer(): InMemoryIngestionConsumer {
  const processor = createIngestionProcessor({
    scrapeRuns: defaultScrapeRunRepository,
    transactions: defaultTransactionRepository,
    auditSink: defaultAuditSink,
    adminAlerts: resolveDefaultAlertSink(),
    scraper: resolveDefaultScraper(),
  });
  return createInMemoryIngestionConsumer({ queue: defaultIngestionQueue, processor });
}

export const defaultIngestionConsumer =
  (globalRegistry.__rdSyncIngestionConsumer ??= createDefaultIngestionConsumer());
