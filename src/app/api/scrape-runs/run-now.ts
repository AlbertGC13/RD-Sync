import { assertCanAccessBankSession, type Principal } from "../../../modules/auth";
import { popularScraperProfile } from "../../../modules/bank-adapters/popular";
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
  now?: () => Date;
  createRunId?: (input: { bankId: string; now: Date }) => string;
}

export interface RunNowResult {
  runId: string;
  bankId: string;
  accountFingerprint: string;
  status: "queued";
}

export async function scheduleAdminIngestionRunNow(
  request: RunNowRequest,
  dependencies: RunNowDependencies,
): Promise<RunNowResult> {
  assertCanAccessBankSession(request.principal);

  const now = dependencies.now?.() ?? new Date();
  const bankId = request.bankId ?? popularScraperProfile.bankId;
  const accountFingerprint =
    request.accountFingerprint ?? popularScraperProfile.accountFingerprint;
  const runId = dependencies.createRunId?.({ bankId, now }) ?? createRunId({ bankId, now });
  const run = await dependencies.scrapeRuns.createQueued({ id: runId, bankId, createdAt: now });

  await scheduleIngestionJob(dependencies.queue, { runId, bankId, accountFingerprint });

  return { runId, bankId, accountFingerprint, status: run.status as "queued" };
}

function createRunId({ bankId, now }: { bankId: string; now: Date }): string {
  const timestamp = now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `${bankId}-${timestamp}`;
}
