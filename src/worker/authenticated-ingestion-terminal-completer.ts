import { createAuditEvent } from "../modules/audit";
import type { IngestionResult } from "./queues";
import { AuthenticatedIngestionTerminalError, type AuthenticatedIngestionTerminalOutcome } from "./authenticated-ingestion-delivery";

type TerminalDependencies = Readonly<{
  scrapeRuns: { markFailed(runId: string, safeErrorSummary: string, endedAt: Date): Promise<void>; markNeedsAdminAction(runId: string, safeErrorSummary: string, endedAt: Date): Promise<void> };
  auditSink?: { record(event: ReturnType<typeof createAuditEvent>): Promise<void> };
  adminAlerts?: { notifyIngestionAttention(input: { runId: string; bankId: string; status: "failed" | "needs_admin_action"; safeErrorSummary: string }): Promise<void> };
  now?: () => Date;
}>;

const summaries = { failed: "Authenticated ingestion delivery failed", needs_admin_action: "Authenticated ingestion requires admin action" } as const;

function identityPart(value: string | null): string {
  if (value === null) return "n";
  return `s${value.length.toString(16)}-${[...value].map((part) => part.charCodeAt(0).toString(16).padStart(4, "0")).join("")}`;
}

export function createAuthenticatedTerminalCompleter(dependencies: TerminalDependencies): (outcome: AuthenticatedIngestionTerminalOutcome) => Promise<IngestionResult> {
  const now = dependencies.now ?? (() => new Date());
  return async ({ runId, bankId, status, reason }) => {
    const summary = reason === "authenticated_ingestion_retry_exhausted" ? "Authenticated ingestion delivery retries exhausted" : summaries[status];
    try {
      if (status === "failed") await dependencies.scrapeRuns.markFailed(runId, summaries.failed, now());
      else await dependencies.scrapeRuns.markNeedsAdminAction(runId, summary, now());
    } catch { throw new AuthenticatedIngestionTerminalError(); }
    const safeBankId = typeof bankId === "string" && /\S/.test(bankId) ? bankId : undefined;
    try {
      await dependencies.auditSink?.record(createAuditEvent({ id: `authenticated-terminal:v1:${[safeBankId ?? null, runId, status, reason].map(identityPart).join(":")}`, actorId: "system:ingestion-worker", actorRole: null, action: `scrape_run.${status}`, target: "scrape_run", targetId: runId, metadata: { stage: "precollection_authentication", reason, status, ...(safeBankId === undefined ? {} : { bankId: safeBankId }) } }));
    } catch { /* Audit delivery cannot change the persisted terminal result. */ }
    if (safeBankId !== undefined) {
      try { await dependencies.adminAlerts?.notifyIngestionAttention({ runId, bankId: safeBankId, status, safeErrorSummary: summary }); } catch { /* Alert delivery cannot change the persisted terminal result. */ }
    }
    return { status, inserted: 0, skipped: 0 };
  };
}
