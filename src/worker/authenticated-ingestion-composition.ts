import type { AuthenticatedSessionCoordinatorDependencies } from "../modules/bank-sessions/ensure-authenticated-session";
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

export function createAuthenticatedTerminalCompleter(
  dependencies: Pick<CollectionDependencies, "scrapeRuns" | "now">,
): (outcome: AuthenticatedIngestionTerminalOutcome) => Promise<IngestionResult> {
  const now = dependencies.now ?? (() => new Date());
  return async ({ runId, status }) => {
    try {
      if (status === "failed") await dependencies.scrapeRuns.markFailed(runId, terminalSummaries.failed, now());
      else await dependencies.scrapeRuns.markNeedsAdminAction(runId, terminalSummaries.needs_admin_action, now());
    } catch {
      throw new AuthenticatedIngestionTerminalError();
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
