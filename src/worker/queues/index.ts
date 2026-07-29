import type { JobsOptions } from "bullmq";

import { createAuditEvent, type AuditSink } from "../../modules/audit";
import { BANK_AUTOLOGIN_ACTIONS } from "../../modules/audit/bank-actions";
import { type BankMovement, type TransactionRecord, normalizeBankMovement } from "../../modules/transactions";
import type { ScrapeTimeAutoLoginOutcome } from "../scraper/auto-login";
import { redactDiagnosticText, type ScrapeCollectionResult } from "../scraper";

export type ScrapeRunStatus = "queued" | "running" | "succeeded" | "failed" | "needs_admin_action" | "throttled";

export interface IngestionJobData {
  runId: string;
  /**
   * Canonical bank code (`Bank.code`), e.g. `"popular"`. Named `bankId` for
   * backward compatibility with the existing BullMQ job payload contract, but
   * the value is a domain code, NOT the Prisma `Bank.id` cuid.
   */
  bankId: string;
  /** Stable session-expiry event id. When present, the processor may run the canonical scrape-time auto-login trigger before collection. */
  expiredEventId?: string;
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

/**
 * Resolves the appropriate `IngestionScraper` for a given canonical bank code
 * (`Bank.code`). Absent/empty bankCode must resolve to the default (Popular)
 * scraper for backward compatibility. An explicitly unknown bankCode must fail
 * closed (return a `needs_admin_action` stub) and never fall back to Popular.
 */
export type ResolveScraper = (bankCode?: string) => IngestionScraper;

export interface ScrapeRunRepository {
  markRunning(runId: string, startedAt?: Date): Promise<void>;
  markSucceeded(runId: string, counts: { insertedCount: number; skippedCount: number }, endedAt?: Date): Promise<void>;
  markNeedsAdminAction(runId: string, safeErrorSummary: string, endedAt?: Date): Promise<void>;
  markThrottled(runId: string, safeErrorSummary: string, endedAt?: Date): Promise<void>;
  markFailed(runId: string, safeErrorSummary: string, endedAt?: Date): Promise<void>;
}

export interface TransactionUpsertRepository {
  upsertMany(records: readonly TransactionRecord[]): Promise<{ inserted: number; skipped: number }>;
}

export interface AdminAlertSink {
  notifyIngestionAttention(event: {
    runId: string;
    bankId: string;
    status: "failed" | "needs_admin_action";
    safeErrorSummary: string;
  }): Promise<void>;
  notifySessionAttention(event: {
    status: "active" | "expired" | "browser_unavailable";
    safeSummary: string;
    checkedAt: string;
  }): Promise<void>;
  /**
   * Optional so existing implementers/mocks keep compiling without changes.
   * Payload is strictly numeric (+ status/checkedAt) — no bankId, since the
   * underlying BrowserSemaphore is a host-wide, process-global singleton.
   */
  notifyCapacityAttention?(event: {
    status: "over_capacity" | "recovered";
    active: number;
    queueDepth: number;
    max: number;
    throttleEventsInWindow: number;
    checkedAt: string;
  }): Promise<void>;
}

export interface IngestionProcessorDependencies {
  scrapeRuns: ScrapeRunRepository;
  transactions: TransactionUpsertRepository;
  /**
   * Resolves the scraper for each job by its canonical `bankCode`. The
   * processor calls `resolveScraper(job.data.bankId)` per job so the worker
   * and in-memory consumer no longer hardcode a single Popular scraper at
   * construction time.
   */
  resolveScraper?: ResolveScraper;
  /**
   * @deprecated Use `resolveScraper` instead. Retained for backward
   * compatibility with tests that inject a single scraper directly. When
   * `resolveScraper` is provided it takes precedence.
   */
  scraper?: IngestionScraper;
  adminAlerts?: AdminAlertSink;
  auditSink?: Pick<AuditSink, "record">;
  now?: () => Date;
  runScrapeTimeAutoLogin?: (job: IngestionJob) => Promise<ScrapeTimeAutoLoginOutcome | null>;
}

export interface QueueLike {
  add(name: string, data: IngestionJobData, options: JobsOptions): Promise<unknown>;
}

export const ingestionJobName = "bank-transaction-ingestion";
const SYSTEM_INGESTION_ACTOR = "system:ingestion-worker";
const SYSTEM_AUTOLOGIN_ACTOR = "system:auto-login";

export function createIngestionProcessor(dependencies: IngestionProcessorDependencies) {
  const now = dependencies.now ?? (() => new Date());
  const resolveScraper = dependencies.resolveScraper;
  const legacyScraper = dependencies.scraper;

  if (!resolveScraper && !legacyScraper) {
    throw new Error(
      "createIngestionProcessor requires either resolveScraper or scraper in dependencies",
    );
  }

  return async function processIngestionJob(job: IngestionJob): Promise<IngestionResult> {
    const requestedBankCode = job.data.bankId;
    const scraper = resolveScraper
      ? resolveScraper(requestedBankCode)
      : legacyScraper!;

    await dependencies.scrapeRuns.markRunning(job.data.runId, now());
    await emitAuditEvent(dependencies.auditSink, {
      action: "scrape_run.started",
      runId: job.data.runId,
      bankId: requestedBankCode,
    });

    try {
      const autoLoginOutcome = await runScrapeTimeAutoLoginIfNeeded(job, dependencies.runScrapeTimeAutoLogin);
      if (autoLoginOutcome?.status === "needs_admin_action") {
        return markNeedsAdminActionTerminal(
          dependencies,
          job.data,
          requestedBankCode,
          autoLoginOutcome.safeSummary,
          now,
        );
      }

      if (autoLoginOutcome?.status === "throttled") {
        return markThrottledDeferred(
          dependencies,
          job.data,
          requestedBankCode,
          autoLoginOutcome.safeSummary,
          now,
        );
      }

      const scrapeResult = await scraper.collect();

      if (scrapeResult.status === "needs_admin_action") {
        const safeErrorSummary = scrapeResult.safeErrorSummary ?? "Bank session requires admin action";
        return markNeedsAdminActionTerminal(
          dependencies,
          job.data,
          requestedBankCode,
          safeErrorSummary,
          now,
        );
      }

      const records = normalizeMovements(scrapeResult.movements, job.data.runId);
      const counts = await dependencies.transactions.upsertMany(records);

      await dependencies.scrapeRuns.markSucceeded(
        job.data.runId,
        { insertedCount: counts.inserted, skippedCount: counts.skipped },
        now(),
      );
      await emitAuditEvent(dependencies.auditSink, {
        action: "scrape_run.succeeded",
        runId: job.data.runId,
        bankId: requestedBankCode,
        metadata: { inserted: counts.inserted, skipped: counts.skipped },
      });

      return { status: "succeeded", inserted: counts.inserted, skipped: counts.skipped };
    } catch (error) {
      const safeErrorSummary = redactDiagnosticText(error instanceof Error ? error.message : "Ingestion failed");
      await dependencies.scrapeRuns.markFailed(job.data.runId, safeErrorSummary, now());
      await notifyAdminAttention(dependencies.adminAlerts, job.data, "failed", safeErrorSummary);
      await emitAuditEvent(dependencies.auditSink, {
        action: "scrape_run.failed",
        runId: job.data.runId,
        bankId: requestedBankCode,
        metadata: { safeErrorSummary },
      });
      return { status: "failed", inserted: 0, skipped: 0 };
    }
  };
}

async function runScrapeTimeAutoLoginIfNeeded(
  job: IngestionJob,
  runScrapeTimeAutoLogin: IngestionProcessorDependencies["runScrapeTimeAutoLogin"],
): Promise<ScrapeTimeAutoLoginOutcome | null> {
  if (!job.data.expiredEventId || !runScrapeTimeAutoLogin) return null;
  try {
    return await runScrapeTimeAutoLogin(job);
  } catch {
    return {
      status: "needs_admin_action",
      reason: "browser_unavailable",
      safeSummary: "Bank auto-login requires admin action",
    };
  }
}

async function markNeedsAdminActionTerminal(
  dependencies: Pick<IngestionProcessorDependencies, "scrapeRuns" | "adminAlerts" | "auditSink">,
  jobData: IngestionJobData,
  requestedBankCode: string,
  safeErrorSummary: string,
  now: () => Date,
): Promise<IngestionResult> {
  await dependencies.scrapeRuns.markNeedsAdminAction(
    jobData.runId,
    safeErrorSummary,
    now(),
  );
  await notifyAdminAttention(dependencies.adminAlerts, jobData, "needs_admin_action", safeErrorSummary);
  await emitAuditEvent(dependencies.auditSink, {
    action: "scrape_run.needs_admin_action",
    runId: jobData.runId,
    bankId: requestedBankCode,
    metadata: { safeErrorSummary },
  });

  return { status: "needs_admin_action", inserted: 0, skipped: 0 };
}

async function markThrottledDeferred(
  dependencies: Pick<IngestionProcessorDependencies, "scrapeRuns" | "auditSink">,
  jobData: IngestionJobData,
  requestedBankCode: string,
  safeErrorSummary: string,
  now: () => Date,
): Promise<IngestionResult> {
  await dependencies.scrapeRuns.markThrottled(jobData.runId, safeErrorSummary, now());
  await emitAuditEvent(dependencies.auditSink, {
    action: "scrape_run.throttled",
    runId: jobData.runId,
    bankId: requestedBankCode,
    metadata: { safeErrorSummary },
  });
  await emitAutoLoginThrottledAuditEvent(
    dependencies.auditSink,
    jobData.runId,
    requestedBankCode,
  );

  return { status: "throttled", inserted: 0, skipped: 0 };
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

async function notifyAdminAttention(
  adminAlerts: AdminAlertSink | undefined,
  jobData: IngestionJobData,
  status: "failed" | "needs_admin_action",
  safeErrorSummary: string,
): Promise<void> {
  await adminAlerts?.notifyIngestionAttention({
    runId: jobData.runId,
    bankId: jobData.bankId,
    status,
    safeErrorSummary,
  });
}

async function emitAuditEvent(
  auditSink: Pick<AuditSink, "record"> | undefined,
  input: { action: string; runId: string; bankId: string; metadata?: Record<string, unknown> },
): Promise<void> {
  if (!auditSink) return;
  try {
    await auditSink.record(
      createAuditEvent({
        actorId: SYSTEM_INGESTION_ACTOR,
        actorRole: null,
        action: input.action,
        target: "scrape_run",
        targetId: input.runId,
        // bankId in audit metadata is the canonical bank code (Bank.code),
        // NOT the Prisma Bank.id. Kept as "bankId" for backward compat with
        // existing audit event consumers.
        metadata: { bankId: input.bankId, ...input.metadata },
      }),
    );
  } catch {
    // Audit failures must never disrupt ingestion
  }
}

async function emitAutoLoginThrottledAuditEvent(
  auditSink: Pick<AuditSink, "record"> | undefined,
  runId: string,
  bankCode: string,
): Promise<void> {
  if (!auditSink) return;
  try {
    await auditSink.record(
      createAuditEvent({
        actorId: SYSTEM_AUTOLOGIN_ACTOR,
        actorRole: null,
        action: BANK_AUTOLOGIN_ACTIONS.SKIPPED,
        target: "scrape_run",
        targetId: runId,
        metadata: { bankCode, reason: "throttled" },
      }),
    );
  } catch {
    // Audit failures must never disrupt ingestion.
  }
}
