import type { AuthenticatedSessionCoordinatorDependencies } from "../modules/bank-sessions/ensure-authenticated-session";
import { createAuditEvent } from "../modules/audit";
import { createAuthenticatedIngestionDeliveryProcessor, AuthenticatedIngestionTerminalError, type AuthenticatedIngestionTerminalOutcome } from "./authenticated-ingestion-delivery";
import { createAuthenticatedIngestionPrecondition } from "./authenticated-ingestion-precondition";
import { createCollectionIngestionProcessor, type CollectionIngestionProcessorDependencies } from "./collection-ingestion-processor";
import type { IngestionResult } from "./queues";
import { createAuthenticatedSessionProbe, type ReadonlySessionChecker } from "./scraper/authenticated-session-probe";
import type { FencedScrapeTimeAutoLoginRunnerDependencies } from "./scraper/scrape-time-auto-login-authentication-execution";
import type { AuthenticationHeartbeatSchedulerDependencies } from "./scraper/authentication-heartbeat-scheduler";
import { resolveAuthenticationHeartbeatConfig } from "./scraper/authentication-heartbeat-scheduler";

type HeartbeatDependencies = Omit<AuthenticationHeartbeatSchedulerDependencies<unknown>, "delayMs">;
type CollectionDependencies = Pick<CollectionIngestionProcessorDependencies, "scrapeRuns" | "transactions" | "resolveScraper" | "adminAlerts" | "auditSink" | "now">;
type TerminalDependencies = Readonly<{
  scrapeRuns: Pick<CollectionDependencies["scrapeRuns"], "markFailed" | "markNeedsAdminAction">;
  auditSink?: Pick<NonNullable<CollectionDependencies["auditSink"]>, "record">;
  adminAlerts?: Pick<NonNullable<CollectionDependencies["adminAlerts"]>, "notifyIngestionAttention">;
  now?: () => Date;
}>;

export type AuthenticatedIngestionProcessorDependencies = Readonly<{
  env: Record<string, string | undefined>;
  popularSessionChecker: ReadonlySessionChecker;
  attempts: AuthenticatedSessionCoordinatorDependencies["attempts"];
  runnerDependencies: FencedScrapeTimeAutoLoginRunnerDependencies;
  heartbeat?: HeartbeatDependencies;
  createOwnerToken: () => string;
}> & CollectionDependencies;

const terminalSummaries = {
  failed: "Authenticated ingestion delivery failed",
  needs_admin_action: "Authenticated ingestion requires admin action",
} as const;

function auditIdentityPart(value: string | null): string {
  if (value === null) return "n";
  let codeUnits = "";
  for (let index = 0; index < value.length; index += 1) codeUnits += value.charCodeAt(index).toString(16).padStart(4, "0");
  return `s${value.length.toString(16)}-${codeUnits}`;
}

function terminalAuditId(runId: string, bankId: string | null, status: "failed" | "needs_admin_action", reason: string): string {
  return `authenticated-terminal:v1:${[bankId, runId, status, reason].map(auditIdentityPart).join(":")}`;
}

export function createAuthenticatedTerminalCompleter(
  dependencies: TerminalDependencies,
): (outcome: AuthenticatedIngestionTerminalOutcome) => Promise<IngestionResult> {
  const now = dependencies.now ?? (() => new Date());
  return async ({ runId, bankId, status, reason }) => {
    try {
      if (status === "failed") await dependencies.scrapeRuns.markFailed(runId, terminalSummaries.failed, now());
      else await dependencies.scrapeRuns.markNeedsAdminAction(runId, terminalSummaries.needs_admin_action, now());
    } catch {
      throw new AuthenticatedIngestionTerminalError();
    }
    const summary = terminalSummaries[status];
    const safeBankId = typeof bankId === "string" && /\S/.test(bankId) ? bankId : undefined;
    try {
      await dependencies.auditSink?.record(createAuditEvent({
        id: terminalAuditId(runId, safeBankId ?? null, status, reason),
        actorId: "system:ingestion-worker",
        actorRole: null,
        action: `scrape_run.${status}`,
        target: "scrape_run",
        targetId: runId,
        metadata: { stage: "precollection_authentication", reason, status, ...(safeBankId === undefined ? {} : { bankId: safeBankId }) },
      }));
    } catch {
      // Audit delivery cannot change the already-persisted terminal result.
    }
    if (safeBankId !== undefined) {
      try {
        await dependencies.adminAlerts?.notifyIngestionAttention({ runId, bankId: safeBankId, status, safeErrorSummary: summary });
      } catch {
        // Alert delivery cannot change the already-persisted terminal result.
      }
    }
    return { status, inserted: 0, skipped: 0 };
  };
}

export function createAuthenticatedIngestionProcessor(
  dependencies: AuthenticatedIngestionProcessorDependencies,
): (job: Readonly<{ data: unknown; signal?: AbortSignal }>) => Promise<IngestionResult> {
  resolveAuthenticationHeartbeatConfig(dependencies.env);
  const probe = createAuthenticatedSessionProbe({ popularSessionChecker: dependencies.popularSessionChecker });
  const downstream = createCollectionIngestionProcessor(dependencies);
  const complete = createAuthenticatedTerminalCompleter(dependencies);
  return createAuthenticatedIngestionDeliveryProcessor({
    authenticate: async ({ identity, ownerToken, job, signal }) => createAuthenticatedIngestionPrecondition({
      env: dependencies.env,
      coordinatorDependencies: { attempts: dependencies.attempts, probe },
      runnerDependencies: dependencies.runnerDependencies,
      job,
      ...(dependencies.heartbeat === undefined ? {} : { heartbeat: dependencies.heartbeat }),
    })({ identity, ownerToken, ...(signal === undefined ? {} : { signal }) }),
    downstream,
    complete,
    createOwnerToken: dependencies.createOwnerToken,
  });
}
