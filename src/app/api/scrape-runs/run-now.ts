import { randomBytes } from "node:crypto";

import { assertCanAccessBankSession, type Principal } from "../../../modules/auth";
import { popularScraperProfile } from "../../../modules/bank-adapters/popular";
import { createAuditEvent, type AuditSink } from "../../../modules/audit";
import type { CreateQueuedScrapeRunInput } from "../../../modules/scrape-runs";
import {
  scheduleIngestionJob,
  type QueueLike,
  type ScrapeRunStatus,
} from "../../../worker/queues";
import { redactDiagnosticText } from "../../../worker/scraper";
import { isSupportedRunNowBankId } from "../../../lib/banks";

export interface RunNowRequest {
  principal: Principal | null;
  bankId?: string;
  accountFingerprint?: string;
}

export interface RunNowDependencies {
  scrapeRuns: {
    createQueued(input: CreateQueuedScrapeRunInput): Promise<{ status: ScrapeRunStatus }>;
    /**
     * Used as a recovery path when the queue rejects a job that was already
     * persisted to the repository. Without it, a transport/Redis failure would
     * leave the run stuck in `queued` forever even though the route already
     * returned 503. Matches the worker's `ScrapeRunRepository.markFailed`
     * signature.
     */
    markFailed(runId: string, safeErrorSummary: string, endedAt?: Date): Promise<void>;
    /**
     * Optional active-run lock. When provided, the scheduler rejects a new
     * manual "Run now" for a bank that already has a `queued` or `running`
     * run, preventing duplicate concurrent ingestion. Optional so tests that
     * don't exercise the lock can omit it; the production default wires it
     * from the shared scrape-run repository.
     */
    hasActiveRunForBank?: (bankId: string) => Promise<boolean>;
  };
  queue: QueueLike;
  auditSink?: Pick<AuditSink, "record">;
  now?: () => Date;
  createRunId?: (input: { bankId: string; now: Date }) => string;
}

export interface RunNowResult {
  runId: string;
  bankId: string;
  accountFingerprint: string;
  status: "queued";
}

/**
 * Typed error so route handlers can distinguish "unsupported bank" from
 * auth/authz denials and infrastructure failures without sniffing message text.
 */
export class UnsupportedRunNowBankError extends Error {
  readonly code = "UNSUPPORTED_BANK" as const;
  readonly bankId: string;
  constructor(bankId: string) {
    super("Unsupported bank for manual run");
    this.name = "UnsupportedRunNowBankError";
    this.bankId = bankId;
  }
}

/**
 * Typed error raised when a manual "Run now" is rejected because the target
 * bank already has an active (`queued` or `running`) run. Route handlers map
 * this to 409 with a safe user-facing message so the UI can surface a clear
 * "wait for the current run" affordance instead of duplicating work.
 */
export class ActiveRunExistsError extends Error {
  readonly code = "ACTIVE_RUN_EXISTS" as const;
  readonly bankId: string;
  constructor(bankId: string) {
    super("An active scrape run already exists for this bank");
    this.name = "ActiveRunExistsError";
    this.bankId = bankId;
  }
}

let lastRunIdTimestamp = "";
let lastRunIdSequence = 0;

export async function scheduleAdminIngestionRunNow(
  request: RunNowRequest,
  dependencies: RunNowDependencies,
): Promise<RunNowResult> {
  const principal = assertCanAccessBankSession(request.principal);

  const now = dependencies.now?.() ?? new Date();
  const requestedBankId = request.bankId ?? popularScraperProfile.bankId;

  // Reject unsupported banks explicitly. Without this check the backend would
  // queue a job that the worker can never satisfy (no adapter registered),
  // and the UI would claim a run was queued for a bank we cannot service.
  if (request.bankId !== undefined && !isSupportedRunNowBankId(request.bankId)) {
    if (dependencies.auditSink) {
      try {
        await dependencies.auditSink.record(
          createAuditEvent({
            actorId: principal.id,
            actorRole: principal.role,
            action: "scrape_run.unsupported_bank",
            target: "scrape_run",
            targetId: null,
            metadata: { bankId: request.bankId },
          }),
        );
      } catch {
        // audit failure must not mask the validation error
      }
    }
    throw new UnsupportedRunNowBankError(request.bankId);
  }

  const bankId = requestedBankId;
  const accountFingerprint =
    request.accountFingerprint ?? popularScraperProfile.accountFingerprint;

  // Active-run lock: reject a new manual run when the target bank already
  // has a `queued` or `running` run. Without this, a rapid second click or a
  // page-level trigger with no awareness of existing runs would schedule a
  // duplicate ingestion for the same bank. The check is optional so tests
  // that don't exercise the lock can omit the dependency; the production
  // default wires it from the shared scrape-run repository.
  if (dependencies.scrapeRuns.hasActiveRunForBank) {
    const hasActiveRun = await dependencies.scrapeRuns.hasActiveRunForBank(bankId);
    if (hasActiveRun) {
      if (dependencies.auditSink) {
        try {
          await dependencies.auditSink.record(
            createAuditEvent({
              actorId: principal.id,
              actorRole: principal.role,
              action: "scrape_run.duplicate_rejected",
              target: "scrape_run",
              targetId: null,
              metadata: { bankId },
            }),
          );
        } catch {
          // audit failure must not mask the lock rejection
        }
      }
      throw new ActiveRunExistsError(bankId);
    }
  }

  const runId = dependencies.createRunId?.({ bankId, now }) ?? createRunId({ bankId, now });
  const run = await dependencies.scrapeRuns.createQueued({ id: runId, bankId, createdAt: now });

  try {
    await scheduleIngestionJob(dependencies.queue, { runId, bankId, accountFingerprint });
  } catch (queueError) {
    // The run is already persisted as `queued` at this point. If the queue
    // rejects the job we must not leave it misleadingly in `queued` state —
    // operators would otherwise see a run that "exists" but is never
    // processed. Mark it failed with a SAFE summary (redactDiagnosticText
    // strips tokens, account numbers, and balances so nothing raw leaks to
    // the admin UI), emit an audit event for the trail, then re-throw so
    // the route can still return a generic 5xx. A failure to mark the run
    // failed is logged but must not mask the original transport error.
    const safeQueueSummary = redactDiagnosticText(
      queueError instanceof Error ? queueError.message : "Queue scheduling failed",
    );
    try {
      await dependencies.scrapeRuns.markFailed(runId, safeQueueSummary, now);
    } catch (markFailedError) {
      console.error("[run-now] could not mark scrape run failed after queue error", {
        runId,
        bankId,
        queueError: queueError instanceof Error
          ? { name: queueError.name, message: queueError.message }
          : queueError,
        markFailedError: markFailedError instanceof Error
          ? { name: markFailedError.name, message: markFailedError.message }
          : markFailedError,
      });
    }

    if (dependencies.auditSink) {
      try {
        await dependencies.auditSink.record(
          createAuditEvent({
            actorId: principal.id,
            actorRole: principal.role,
            action: "scrape_run.queue_failed",
            target: "scrape_run",
            targetId: runId,
            metadata: { bankId, safeErrorSummary: safeQueueSummary },
          }),
        );
      } catch {
        // audit failure must not mask the queue failure
      }
    }

    throw queueError;
  }

  if (dependencies.auditSink) {
    try {
      await dependencies.auditSink.record(
        createAuditEvent({
          actorId: principal.id,
          actorRole: principal.role,
          action: "scrape_run.scheduled",
          target: "scrape_run",
          targetId: runId,
          metadata: { bankId, accountFingerprint },
        }),
      );
    } catch {
      // audit failure must not break the queued run
    }
  }

  return { runId, bankId, accountFingerprint, status: run.status as "queued" };
}

export function createRunId({ bankId, now }: { bankId: string; now: Date }): string {
  const timestamp = now.toISOString().replace(/\D/g, "").slice(0, 17);
  lastRunIdSequence = timestamp === lastRunIdTimestamp ? (lastRunIdSequence + 1) % 36 : 0;
  lastRunIdTimestamp = timestamp;

  const suffix = `${randomBytes(2).toString("hex").slice(0, 3)}${lastRunIdSequence.toString(36)}`;
  return `${bankId}-${timestamp}-${suffix}`;
}
