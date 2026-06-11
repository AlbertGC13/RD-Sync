import { popularPortalFixture, parsePopularTransactionRows } from "../../../modules/bank-adapters/popular";
import { createIngestionProcessor } from "../../../worker/queues";
import type { IngestionScraper } from "../../../worker/queues";
import { createInMemoryIngestionConsumer } from "../../../worker/ingestion-consumer";
import { resolveDefaultAlertSink } from "../../../worker/alerts/email-alert-sink";
import { defaultAuditSink } from "../audit/defaults";
import { defaultTransactionRepository } from "../transactions/defaults";
import { defaultIngestionQueue, defaultScrapeRunRepository } from "./defaults";

/**
 * Resolves the default IngestionScraper for the local/dev server.
 *
 * - RD_SYNC_DEV_PREVIEW=enabled → fixture-backed scraper (Popular portal fixture).
 * - Otherwise → a scraper that reports needs_admin_action so production never
 *   fabricates data while real bank navigation is not yet wired (PR5+).
 */
function resolveDefaultScraper(): IngestionScraper {
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

const defaultProcessor = createIngestionProcessor({
  scrapeRuns: defaultScrapeRunRepository,
  transactions: defaultTransactionRepository,
  auditSink: defaultAuditSink,
  adminAlerts: resolveDefaultAlertSink(),
  scraper: resolveDefaultScraper(),
});

export const defaultIngestionConsumer = createInMemoryIngestionConsumer({
  queue: defaultIngestionQueue,
  processor: defaultProcessor,
});
