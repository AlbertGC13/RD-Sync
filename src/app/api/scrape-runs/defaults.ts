/**
 * Default scrape-run repository singleton.
 *
 * Env-switch: When DATABASE_URL is set (read at module-load time, consistent
 * with the existing pattern), the Prisma-backed repository is used instead of
 * the in-memory one. Both implementations satisfy the same interface so no
 * consumer code changes are required.
 *
 * Queue env-switch: When RD_SYNC_REDIS_URL is set, the default ingestion queue
 * is a real BullMQ-backed queue connected to Redis.  Otherwise the
 * InMemoryScheduledIngestionQueue is used (dev/test default, no Redis needed).
 *
 * The instances are anchored on globalThis so that Next.js dev module-graph
 * hot-reloads and multiple module graphs within the same process share a
 * single instance.
 */

import type { JobsOptions } from "bullmq";

import {
  InMemoryScrapeRunRepository,
  toDashboardScrapeRun,
  type DashboardScrapeRun,
  type ScrapeRunFilters,
  type ScrapeRunRecord,
} from "../../../modules/scrape-runs/index";
import { PrismaScrapeRunRepository } from "../../../modules/persistence/prisma-scrape-run-repository";
import type { IngestionJobData, QueueLike } from "../../../worker/queues/index";
import { buildRedisConnectionOptions, createBullmqIngestionQueue } from "../../../worker/queues/bullmq-queue";

// ---------------------------------------------------------------------------
// InMemoryScheduledIngestionQueue
// (declared before globalRegistry so the type is available below)
// ---------------------------------------------------------------------------

export class InMemoryScheduledIngestionQueue implements QueueLike {
  readonly jobs: Array<{ name: string; data: IngestionJobData; options: JobsOptions }> = [];

  async add(name: string, data: IngestionJobData, options: JobsOptions): Promise<void> {
    this.jobs.push({ name, data, options });
  }
}

// ---------------------------------------------------------------------------
// globalThis anchors — one instance shared across all Next.js module graphs
// ---------------------------------------------------------------------------

type AnyScrapeRunRepository = InMemoryScrapeRunRepository | PrismaScrapeRunRepository;

/**
 * The ingestion queue is always an InMemoryScheduledIngestionQueue when
 * RD_SYNC_REDIS_URL is not set (dev/test default), or a BullMQ-backed
 * QueueLike when it is set (production/staging).
 *
 * Exported as the minimal QueueLike interface so callers are not misled into
 * believing .jobs is always available.  The .jobs accessor only exists on
 * InMemoryScheduledIngestionQueue; code that needs it must narrow with
 * instanceof InMemoryScheduledIngestionQueue first.
 */

const globalRegistry = globalThis as typeof globalThis & {
  __rdSyncScrapeRunRepository?: AnyScrapeRunRepository;
  __rdSyncIngestionQueue?: QueueLike;
  __rdSyncPreviewScrapeRunsSeeded?: boolean;
};

function createScrapeRunRepository(): AnyScrapeRunRepository {
  if (process.env.DATABASE_URL) {
    return new PrismaScrapeRunRepository();
  }
  return new InMemoryScrapeRunRepository();
}

/**
 * When RD_SYNC_REDIS_URL is set, return a BullMQ-backed queue.
 * Otherwise fall back to the in-memory queue (dev/test default).
 *
 * The BullMQ queue is created with `maxRetriesPerRequest: null` as required
 * by BullMQ for blocking Redis connections.  No actual Redis connection is
 * opened here — BullMQ connects lazily on the first operation.
 */
function createIngestionQueue(): QueueLike {
  const redisUrl = process.env.RD_SYNC_REDIS_URL;
  if (redisUrl) {
    return createBullmqIngestionQueue({
      connection: buildRedisConnectionOptions(redisUrl),
    });
  }
  return new InMemoryScheduledIngestionQueue();
}

export const defaultScrapeRunRepository: AnyScrapeRunRepository =
  (globalRegistry.__rdSyncScrapeRunRepository ??= createScrapeRunRepository());

// Changing RD_SYNC_REDIS_URL requires a full process restart — the queue
// backend is chosen once at first module load and cached for the lifetime of
// the Node.js process (matching the DATABASE_URL pattern).
export const defaultIngestionQueue: QueueLike =
  (globalRegistry.__rdSyncIngestionQueue ??= createIngestionQueue());

// ---------------------------------------------------------------------------
// Preview seeding helpers
// ---------------------------------------------------------------------------

export function createPreviewScrapeRunRecords(now = new Date()): ScrapeRunRecord[] {
  return [
    {
      id: "preview-run-1",
      bankId: "popular",
      status: "needs_admin_action",
      startedAt: new Date(now.getTime() - 1000 * 60 * 5),
      endedAt: new Date(now.getTime() - 1000 * 60 * 4),
      insertedCount: 0,
      skippedCount: 0,
      safeErrorSummary: "Bank session requires admin MFA action",
      createdAt: new Date(now.getTime() - 1000 * 60 * 5),
      updatedAt: new Date(now.getTime() - 1000 * 60 * 4),
    },
    {
      id: "preview-run-2",
      bankId: "banreservas",
      status: "succeeded",
      startedAt: new Date(now.getTime() - 1000 * 60 * 90),
      endedAt: new Date(now.getTime() - 1000 * 60 * 88),
      insertedCount: 12,
      skippedCount: 3,
      safeErrorSummary: null,
      createdAt: new Date(now.getTime() - 1000 * 60 * 90),
      updatedAt: new Date(now.getTime() - 1000 * 60 * 88),
    },
    {
      id: "preview-run-3",
      bankId: "bhd",
      status: "failed",
      startedAt: new Date(now.getTime() - 1000 * 60 * 60 * 2),
      endedAt: new Date(now.getTime() - 1000 * 60 * 60 * 2 + 60_000),
      insertedCount: 0,
      skippedCount: 0,
      safeErrorSummary: "Transaction table selector missing",
      createdAt: new Date(now.getTime() - 1000 * 60 * 60 * 2),
      updatedAt: new Date(now.getTime() - 1000 * 60 * 60 * 2 + 60_000),
    },
    {
      id: "preview-run-4",
      bankId: "popular",
      status: "succeeded",
      startedAt: new Date(now.getTime() - 1000 * 60 * 60 * 5),
      endedAt: new Date(now.getTime() - 1000 * 60 * 60 * 5 + 75_000),
      insertedCount: 8,
      skippedCount: 0,
      safeErrorSummary: null,
      createdAt: new Date(now.getTime() - 1000 * 60 * 60 * 5),
      updatedAt: new Date(now.getTime() - 1000 * 60 * 60 * 5 + 75_000),
    },
  ];
}

export async function seedPreviewScrapeRunsIfEnabled() {
  // Use a globalThis flag so the seed runs at most once across all module graphs.
  if (process.env.RD_SYNC_DEV_PREVIEW !== "enabled" || globalRegistry.__rdSyncPreviewScrapeRunsSeeded) {
    return;
  }

  globalRegistry.__rdSyncPreviewScrapeRunsSeeded = true;

  for (const run of createPreviewScrapeRunRecords()) {
    await defaultScrapeRunRepository.createQueued({
      id: run.id,
      bankId: run.bankId,
      createdAt: run.createdAt,
    });
    if (run.status === "running") {
      await defaultScrapeRunRepository.markRunning(run.id, run.startedAt ?? run.createdAt);
    }
    if (run.status === "succeeded") {
      await defaultScrapeRunRepository.markSucceeded(
        run.id,
        { insertedCount: run.insertedCount, skippedCount: run.skippedCount },
        run.endedAt ?? run.updatedAt,
      );
    }
    if (run.status === "needs_admin_action") {
      await defaultScrapeRunRepository.markNeedsAdminAction(
        run.id,
        run.safeErrorSummary ?? "Bank session requires admin action",
        run.endedAt ?? run.updatedAt,
      );
    }
    if (run.status === "failed") {
      await defaultScrapeRunRepository.markFailed(
        run.id,
        run.safeErrorSummary ?? "Scrape run failed",
        run.endedAt ?? run.updatedAt,
      );
    }
  }
}

export async function listScrapeRunsForPage(
  filters: ScrapeRunFilters,
): Promise<DashboardScrapeRun[]> {
  await seedPreviewScrapeRunsIfEnabled();
  const records = await defaultScrapeRunRepository.list(filters);
  return records.map(toDashboardScrapeRun);
}
