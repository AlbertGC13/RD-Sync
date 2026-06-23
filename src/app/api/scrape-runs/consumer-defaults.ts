import { popularPortalFixture, parsePopularTransactionRows } from "../../../modules/bank-adapters/popular";
import { createIngestionProcessor } from "../../../worker/queues";
import type { IngestionJob, IngestionScraper } from "../../../worker/queues";
import { createInMemoryIngestionConsumer, type InMemoryIngestionConsumer } from "../../../worker/ingestion-consumer";
import { redactDiagnosticText } from "../../../worker/scraper";
import { resolveDefaultAlertSink } from "../../../worker/alerts/email-alert-sink";
import {
  createPopularCdpScraper,
  type PopularCdpScraperOptions,
} from "../../../worker/scraper/navigation/popular-cdp";
import { createEnsureBrowserFromEnv, type EnsureBrowserSeam } from "../../../worker/scraper/browser-runtime";
import { defaultAuditSink } from "../audit/defaults";
import { defaultTransactionRepository } from "../transactions/defaults";
import { defaultIngestionQueue, defaultScrapeRunRepository, InMemoryScheduledIngestionQueue } from "./defaults";

const globalRegistry = globalThis as typeof globalThis & {
  __rdSyncIngestionConsumer?: InMemoryIngestionConsumer | undefined;
  __rdSyncIngestionConsumerInitialized?: boolean;
};

/**
 * Builds the Popular CDP scraper options from the given env. Pure and
 * testable — it never touches process.env directly when env is injected.
 *
 * Returns `undefined` when the popular-cdp scraper is not selected, so callers
 * can fall through to the other branches.
 *
 * The `ensureBrowser` seam is included only when
 * `RD_SYNC_BANK_BROWSER_AUTO_LAUNCH=enabled` (and `RD_SYNC_CDP_URL` is set);
 * otherwise it is `undefined` and the scraper connects directly as before
 * (backward compatible). This is the env-wiring contract the scraper relies
 * on — see consumer-defaults-popular-cdp.test.ts for the behaviour proof.
 */
export function buildPopularCdpScraperOptionsFromEnv(
  env: Record<string, string | undefined> = process.env,
): PopularCdpScraperOptions | undefined {
  if (env.RD_SYNC_SCRAPER !== "popular-cdp") {
    return undefined;
  }

  const ensureBrowser: EnsureBrowserSeam | undefined = createEnsureBrowserFromEnv(env);
  return {
    cdpUrl: env.RD_SYNC_CDP_URL,
    ensureBrowser,
  };
}

/**
 * Resolves the default IngestionScraper based on env vars read at call time.
 *
 * Note: this function is also called once at module-load time (line below) to
 * construct the module-level `defaultProcessor`. Env vars are therefore read at
 * import time for that instance, not lazily per request.
 *
 * - RD_SYNC_SCRAPER=popular-cdp → CDP-attach scraper (Via B: attaches to
 *   a human-opened Brave session; cdpUrl from RD_SYNC_CDP_URL). When
 *   RD_SYNC_BANK_BROWSER_AUTO_LAUNCH=enabled, an ensureBrowser seam is wired
 *   in so the worker starts the browser before connecting.
 * - RD_SYNC_DEV_PREVIEW=enabled → fixture-backed scraper (Popular portal fixture).
 * - Otherwise → stub that reports needs_admin_action so production never
 *   fabricates data while real bank navigation is not configured.
 */
export function resolveDefaultScraper(): IngestionScraper {
  const popularOptions = buildPopularCdpScraperOptionsFromEnv();
  if (popularOptions) {
    // Only the worker/scraper path launches the browser — the read-only
    // session checker never does. The ensureBrowser seam (when present) is
    // built from env by buildPopularCdpScraperOptionsFromEnv.
    return createPopularCdpScraper(popularOptions);
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
    scraper: resolveDefaultScraper(),
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
