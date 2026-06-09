import {
  InMemoryScrapeRunRepository,
  toDashboardScrapeRun,
  type DashboardScrapeRun,
  type ScrapeRunFilters,
  type ScrapeRunRecord,
} from "../../../modules/scrape-runs";
import type { IngestionJobData, QueueLike } from "../../../worker/queues";

export const defaultScrapeRunRepository = new InMemoryScrapeRunRepository();

let previewScrapeRunsSeeded = false;

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
  if (process.env.RD_SYNC_DEV_PREVIEW !== "enabled" || previewScrapeRunsSeeded) {
    return;
  }

  previewScrapeRunsSeeded = true;

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

export class InMemoryScheduledIngestionQueue implements QueueLike {
  readonly jobs: Array<{ name: string; data: IngestionJobData }> = [];

  async add(name: string, data: IngestionJobData): Promise<void> {
    this.jobs.push({ name, data });
  }
}

export const defaultIngestionQueue = new InMemoryScheduledIngestionQueue();
