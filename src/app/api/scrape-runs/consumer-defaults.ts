import type { IngestionJob } from "../../../worker/queues";
import { createInMemoryIngestionConsumer, type InMemoryIngestionConsumer } from "../../../worker/ingestion-consumer";
import { resolveDefaultAlertSink } from "../../../worker/alerts/email-alert-sink";
import { createDisabledAuthenticatedIngestionProcessor } from "../../../worker/authenticated-ingestion-activation";
import { createAuthenticatedTerminalCompleter } from "../../../worker/authenticated-ingestion-terminal-completer";
import { defaultAuditSink } from "../audit/defaults";
import { defaultIngestionQueue, defaultScrapeRunRepository, InMemoryScheduledIngestionQueue } from "./defaults";

const globalRegistry = globalThis as typeof globalThis & {
  __rdSyncIngestionConsumer?: InMemoryIngestionConsumer | undefined;
  __rdSyncIngestionConsumerInitialized?: boolean;
};


/**
 * When RD_SYNC_REDIS_URL is set, a separate worker process consumes the
 * BullMQ queue — there is no in-process consumer and drainPending() must NOT
 * be called from within the API process.  Return undefined so the run-now
 * route skips the drain step.
 *
 * Without RD_SYNC_REDIS_URL the existing in-memory consumer is wired up as
 * before (dev default, no Redis required).
 */
export function createDefaultInMemoryIngestionConsumer(): InMemoryIngestionConsumer | undefined {
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

  const complete = createAuthenticatedTerminalCompleter({
    scrapeRuns: defaultScrapeRunRepository,
    auditSink: defaultAuditSink,
    adminAlerts: resolveDefaultAlertSink(),
  });
  const processor = createDisabledAuthenticatedIngestionProcessor({ complete });
  return createInMemoryIngestionConsumer({
    queue: defaultIngestionQueue,
    processor,
    // Recovery for the in-memory drain orphan: when a dequeued job's
    // processor throws before its own failure catch (e.g. `markRunning`
    // rejecting), mark the scrape run `failed` with a redacted summary so it
    // is never left in `queued` with no pending job. Mirrors the queue-failure
    // recovery in run-now.ts. Never persist processor diagnostics from this
    // terminal-only fallback.
    onJobError: async (job: IngestionJob) => {
      await defaultScrapeRunRepository.markFailed(job.data.runId, "In-memory ingestion job failed.", new Date());
    },
  });
}

function getOrCreateDefaultIngestionConsumer(): InMemoryIngestionConsumer | undefined {
  if (!globalRegistry.__rdSyncIngestionConsumerInitialized) {
    globalRegistry.__rdSyncIngestionConsumer = createDefaultInMemoryIngestionConsumer();
    globalRegistry.__rdSyncIngestionConsumerInitialized = true;
  }
  return globalRegistry.__rdSyncIngestionConsumer;
}

export const defaultIngestionConsumer: InMemoryIngestionConsumer | undefined =
  getOrCreateDefaultIngestionConsumer();
