import { randomBytes } from "node:crypto";

import { assertCanAccessBankSession, type Principal } from "../../../modules/auth";
import { popularScraperProfile } from "../../../modules/bank-adapters/popular";
import { createAuditEvent, type AuditSink } from "../../../modules/audit";
import type { CreateQueuedScrapeRunInput } from "../../../modules/scrape-runs";
import { scheduleIngestionJob, type QueueLike, type ScrapeRunStatus } from "../../../worker/queues";

export interface RunNowRequest {
  principal: Principal | null;
  bankId?: string;
  accountFingerprint?: string;
}

export interface RunNowDependencies {
  scrapeRuns: {
    createQueued(input: CreateQueuedScrapeRunInput): Promise<{ status: ScrapeRunStatus }>;
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

let lastRunIdTimestamp = "";
let lastRunIdSequence = 0;

export async function scheduleAdminIngestionRunNow(
  request: RunNowRequest,
  dependencies: RunNowDependencies,
): Promise<RunNowResult> {
  const principal = assertCanAccessBankSession(request.principal);

  const now = dependencies.now?.() ?? new Date();
  const bankId = request.bankId ?? popularScraperProfile.bankId;
  const accountFingerprint =
    request.accountFingerprint ?? popularScraperProfile.accountFingerprint;
  const runId = dependencies.createRunId?.({ bankId, now }) ?? createRunId({ bankId, now });
  const run = await dependencies.scrapeRuns.createQueued({ id: runId, bankId, createdAt: now });

  await scheduleIngestionJob(dependencies.queue, { runId, bankId, accountFingerprint });

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
