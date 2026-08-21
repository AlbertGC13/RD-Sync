import type { IngestionJob } from "../../../worker/queues";
import { createInMemoryIngestionConsumer, type InMemoryIngestionConsumer } from "../../../worker/ingestion-consumer";
import { resolveDefaultAlertSink } from "../../../worker/alerts/email-alert-sink";
import { getBrowserCapacitySnapshotFromEnv } from "../../../worker/scraper/browser-runtime";
import {
  createBrowserCapacityMonitor,
  type BrowserCapacityMonitor,
} from "../../../modules/observability/browser-capacity-monitor";
import {
  createDisabledAuthenticatedIngestionProcessor,
  resolveAuthenticatedIngestionActivation,
} from "../../../worker/authenticated-ingestion-activation";
import { createAuthenticatedTerminalCompleter } from "../../../worker/authenticated-ingestion-composition";
import { bankAdapterRegistry } from "../../../modules/bank-adapters/registry";
import { defaultAuditSink } from "../audit/defaults";
import { defaultIngestionQueue, defaultScrapeRunRepository, InMemoryScheduledIngestionQueue } from "./defaults";

export { buildPopularCdpScraperOptionsFromEnv } from "../../../modules/bank-adapters/registry";

const globalRegistry = globalThis as typeof globalThis & {
  __rdSyncIngestionConsumer?: InMemoryIngestionConsumer | undefined;
  __rdSyncIngestionConsumerInitialized?: boolean;
};

const AUTHENTICATED_INGESTION_REDIS_REQUIRED = "Authenticated ingestion requires a Redis worker.";

export function resolveDefaultScraper(bankCode?: string) {
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

function createDefaultIngestionConsumer(): InMemoryIngestionConsumer | undefined {
  const activation = resolveAuthenticatedIngestionActivation(process.env.RD_SYNC_AUTHENTICATED_INGESTION);
  const redisConfigured = Boolean(process.env.RD_SYNC_REDIS_URL);

  if (activation.status === "enabled") {
    if (!redisConfigured) throw new Error(AUTHENTICATED_INGESTION_REDIS_REQUIRED);
    return undefined;
  }

  // Separate worker ownership applies to disabled deliveries too; the API
  // process must not construct collection, browser, or authentication wiring.
  if (redisConfigured) return undefined;

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

  const processor = createDisabledAuthenticatedIngestionProcessor({
    complete: createAuthenticatedTerminalCompleter({
      scrapeRuns: defaultScrapeRunRepository,
      auditSink: defaultAuditSink,
      adminAlerts: resolveDefaultAlertSink(),
    }),
  });
  return createInMemoryIngestionConsumer({
    queue: defaultIngestionQueue,
    processor,
    onJobError: async (job: IngestionJob, error: Error) => {
      await defaultScrapeRunRepository.markFailed(job.data.runId, error.message, new Date());
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

// ---------------------------------------------------------------------------
// defaultBrowserCapacityMonitor
//
// Env-gated wiring for the host-wide browser capacity monitor, mirroring
// resolveDefaultSessionMonitor in src/app/api/bank-sessions/defaults.ts.
//
// Relevant env vars:
//   RD_SYNC_BROWSER_CAPACITY_MONITOR              — "enabled" activates the monitor
//   RD_SYNC_BROWSER_CAPACITY_CHECK_INTERVAL_MS    — poll interval ms (default 60000, min 30000)
// ---------------------------------------------------------------------------

const CAPACITY_MIN_INTERVAL_MS = 30_000;
const CAPACITY_DEFAULT_INTERVAL_MS = 60_000;

function resolveCapacityIntervalMs(): number {
  const raw = process.env.RD_SYNC_BROWSER_CAPACITY_CHECK_INTERVAL_MS;
  if (!raw) return CAPACITY_DEFAULT_INTERVAL_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return CAPACITY_DEFAULT_INTERVAL_MS;
  return Math.max(parsed, CAPACITY_MIN_INTERVAL_MS);
}

/**
 * Returns a browser capacity monitor wired to the real shared BrowserSemaphore
 * singleton, the default alert sink, and the default audit sink — or null
 * when RD_SYNC_BROWSER_CAPACITY_MONITOR !== "enabled".
 */
export function resolveDefaultBrowserCapacityMonitor(): BrowserCapacityMonitor | null {
  if (process.env.RD_SYNC_BROWSER_CAPACITY_MONITOR !== "enabled") {
    return null;
  }

  return createBrowserCapacityMonitor({
    sample: getBrowserCapacitySnapshotFromEnv,
    alertSink: resolveDefaultAlertSink(),
    auditSink: defaultAuditSink,
    intervalMs: resolveCapacityIntervalMs(),
  });
}

const capacityGlobalRegistry = globalThis as typeof globalThis & {
  __rdSyncBrowserCapacityMonitor?: BrowserCapacityMonitor | null;
};

// Sentinel distinguishes "not yet initialised" from "null (disabled)".
if (!("__rdSyncBrowserCapacityMonitor" in capacityGlobalRegistry)) {
  capacityGlobalRegistry.__rdSyncBrowserCapacityMonitor = resolveDefaultBrowserCapacityMonitor();
}

// This module already eagerly constructs defaultIngestionConsumer above at
// load time, so the capacity monitor follows the same eager side-effecting
// pattern — start() is idempotent (internal handle guard).
export const defaultBrowserCapacityMonitor: BrowserCapacityMonitor | null =
  capacityGlobalRegistry.__rdSyncBrowserCapacityMonitor ?? null;

defaultBrowserCapacityMonitor?.start();
