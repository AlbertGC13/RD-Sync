import type { JobsOptions } from "bullmq";

import { type BankMovement, type TransactionRecord, normalizeBankMovement } from "../../modules/transactions";
import { redactDiagnosticText, type ScrapeCollectionResult } from "../scraper";

export type ScrapeRunStatus = "queued" | "running" | "succeeded" | "failed" | "needs_admin_action";

export interface IngestionJobData {
  runId: string;
  bankId: string;
  accountFingerprint: string;
}

export interface IngestionJob {
  data: IngestionJobData;
}

export interface IngestionResult {
  status: Exclude<ScrapeRunStatus, "queued" | "running">;
  inserted: number;
  skipped: number;
}

export interface IngestionScraper {
  collect(): Promise<ScrapeCollectionResult>;
}

export interface ScrapeRunRepository {
  markRunning(runId: string, startedAt?: Date): Promise<void>;
  markSucceeded(runId: string, counts: { insertedCount: number; skippedCount: number }, endedAt?: Date): Promise<void>;
  markNeedsAdminAction(runId: string, safeErrorSummary: string, endedAt?: Date): Promise<void>;
  markFailed(runId: string, safeErrorSummary: string, endedAt?: Date): Promise<void>;
}

export interface TransactionUpsertRepository {
  upsertMany(records: readonly TransactionRecord[]): Promise<{ inserted: number; skipped: number }>;
}

export interface IngestionProcessorDependencies {
  scrapeRuns: ScrapeRunRepository;
  transactions: TransactionUpsertRepository;
  scraper: IngestionScraper;
  now?: () => Date;
}

export interface QueueLike {
  add(name: string, data: IngestionJobData, options: JobsOptions): Promise<unknown>;
}

const ingestionJobName = "bank-transaction-ingestion";

export function createIngestionProcessor(dependencies: IngestionProcessorDependencies) {
  const now = dependencies.now ?? (() => new Date());

  return async function processIngestionJob(job: IngestionJob): Promise<IngestionResult> {
    await dependencies.scrapeRuns.markRunning(job.data.runId, now());

    try {
      const scrapeResult = await dependencies.scraper.collect();

      if (scrapeResult.status === "needs_admin_action") {
        await dependencies.scrapeRuns.markNeedsAdminAction(
          job.data.runId,
          scrapeResult.safeErrorSummary ?? "Bank session requires admin action",
          now(),
        );

        return { status: "needs_admin_action", inserted: 0, skipped: 0 };
      }

      const records = normalizeMovements(scrapeResult.movements, job.data.runId);
      const counts = await dependencies.transactions.upsertMany(records);

      await dependencies.scrapeRuns.markSucceeded(
        job.data.runId,
        { insertedCount: counts.inserted, skippedCount: counts.skipped },
        now(),
      );

      return { status: "succeeded", inserted: counts.inserted, skipped: counts.skipped };
    } catch (error) {
      const safeErrorSummary = redactDiagnosticText(error instanceof Error ? error.message : "Ingestion failed");
      await dependencies.scrapeRuns.markFailed(job.data.runId, safeErrorSummary, now());
      return { status: "failed", inserted: 0, skipped: 0 };
    }
  };
}

export function createIngestionQueueOptions(runId: string): JobsOptions {
  return {
    jobId: runId,
    attempts: 3,
    backoff: { type: "exponential", delay: 30_000 },
    removeOnComplete: 100,
    removeOnFail: 250,
  };
}

export async function scheduleIngestionJob(queue: QueueLike, data: IngestionJobData): Promise<void> {
  await queue.add(ingestionJobName, data, createIngestionQueueOptions(data.runId));
}

function normalizeMovements(movements: readonly BankMovement[], scrapeRunId: string): TransactionRecord[] {
  return movements.map((movement) => normalizeBankMovement(movement, { scrapeRunId }));
}
