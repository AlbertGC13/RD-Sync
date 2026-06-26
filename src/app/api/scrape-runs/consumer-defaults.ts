import { createIngestionProcessor } from "../../../worker/queues";
import type { IngestionJob, IngestionScraper } from "../../../worker/queues";
import { createInMemoryIngestionConsumer, type InMemoryIngestionConsumer } from "../../../worker/ingestion-consumer";
import { redactDiagnosticText } from "../../../worker/scraper";
import { resolveDefaultAlertSink } from "../../../worker/alerts/email-alert-sink";
import { bankAdapterRegistry } from "../../../modules/bank-adapters/registry";
import { defaultAuditSink } from "../audit/defaults";
import { defaultTransactionRepository } from "../transactions/defaults";
import { defaultIngestionQueue, defaultScrapeRunRepository, InMemoryScheduledIngestionQueue } from "./defaults";

// Re-exported so existing imports of the env-wiring helper from this module
// keep working. The implementation now lives in the adapter registry, which
// owns Popular scraper wiring.
export { buildPopularCdpScraperOptionsFromEnv } from "../../../modules/bank-adapters/registry";

const globalRegistry = globalThis as typeof globalThis & {
  __rdSyncIngestionConsumer?: InMemoryIngestionConsumer | undefined;
  __rdSyncIngestionConsumerInitialized?: boolean;
};

/**
 * Resolves the default IngestionScraper by routing through the bank adapter
 * registry keyed by canonical `bankCode` (`Bank.code`).
 *
 * Note: this function is also called once at module-load time (line below) to
 * construct the module-level `defaultProcessor`. Env vars are therefore read
 * lazily inside the Popular adapter's `createScraper` at call time.
 *
 * Routing contract (PR1, no behaviour change for Popular):
 * - `bankCode` absent/empty/whitespace -> defaults to `popular` for backward
 *   compatibility (legacy/default runs). Only absent bankCode may default to
 *   Popular.
 * - `bankCode` explicitly present and registered -> that bank's adapter scraper
 *   (Popular env logic: popular-cdp > dev-preview fixture > needs_admin_action
 *   stub, exactly as before).
 * - `bankCode` explicitly present but NOT registered -> fail closed
 *   (needs_admin_action with a safe summary). It NEVER falls back to Popular.
 *   The 400 + audit for unknown banks is enforced in run-now; this consumer
 *   path fails safely if an unknown code ever reaches it.
 */
export function resolveDefaultScraper(bankCode?: string): IngestionScraper {
  const code = bankCode && bankCode.trim() ? bankCode.trim() : "popular";
  const adapter = bankAdapterRegistry.get(code);
  if (!adapter) {
    return {
      collect: async () => ({
        status: "needs_admin_action" as const,
        movements: [],
        safeErrorSummary: "Bank not configured for automated scraping",
      }),
    };
  }
  return adapter.createScraper();
}

/**
 * When RD_SYNC_REDIS_URL is set, a separate worker process consumes the
 * BullMQ queue — there is no in-process consumer and drainPending() must NOT
 * be called from within the API process.  Return undefined so the run-now
 * route skips the drain step.
 *
 * Without RD_SYNC_REDIS_URL the existing in-memory consumer is wired up as
 * before (dev default, no Redis required).
 */
function createDefaultIngestionConsumer(): InMemoryIngestionConsumer | undefined {
  if (process.env.RD_SYNC_REDIS_URL) {
    // BullMQ mode — consumer runs in the separate worker process.
    return undefined;
  }

  if (!(defaultIngestionQueue instanceof InMemoryScheduledIngestionQueue)) {
    // Defensive guard against module-load ordering edge cases: if the
    // globalThis-cached queue was populated in a prior module graph (where
    // RD_SYNC_REDIS_URL was absent) and the env var is now absent but the
    // cached value is a BullMQ adapter, this guard catches the mismatch
    // instead of passing a QueueLike to createInMemoryIngestionConsumer which
    // requires InMemoryScheduledIngestionQueue.  Also serves as a narrowing
    // assertion so TypeScript knows the type at line below.
    return undefined;
  }

  const processor = createIngestionProcessor({
    scrapeRuns: defaultScrapeRunRepository,
    transactions: defaultTransactionRepository,
    auditSink: defaultAuditSink,
    adminAlerts: resolveDefaultAlertSink(),
    resolveScraper: resolveDefaultScraper,
  });
  return createInMemoryIngestionConsumer({
    queue: defaultIngestionQueue,
    processor,
    // Recovery for the in-memory drain orphan: when a dequeued job's
    // processor throws before its own failure catch (e.g. `markRunning`
    // rejecting), mark the scrape run `failed` with a redacted summary so it
    // is never left in `queued` with no pending job. Mirrors the queue-failure
    // recovery in run-now.ts.
    onJobError: async (job: IngestionJob, error: Error) => {
      const safeSummary = redactDiagnosticText(error.message);
      await defaultScrapeRunRepository.markFailed(job.data.runId, safeSummary, new Date());
    },
  });
}

function getOrCreateDefaultIngestionConsumer(): InMemoryIngestionConsumer | undefined {
  if (!globalRegistry.__rdSyncIngestionConsumerInitialized) {
    globalRegistry.__rdSyncIngestionConsumer = createDefaultIngestionConsumer();
    globalRegistry.__rdSyncIngestionConsumerInitialized = true;
  }
  return globalRegistry.__rdSyncIngestionConsumer;
}

export const defaultIngestionConsumer: InMemoryIngestionConsumer | undefined =
  getOrCreateDefaultIngestionConsumer();
