import { createAuditEvent, type AuditSink } from "../modules/audit";
import { BANK_AUTOLOGIN_ACTIONS } from "../modules/audit/bank-actions";
import type { AutoLoginOutcomeHookMetadata } from "./scraper/auto-login";

const SYSTEM_AUTOLOGIN_ACTOR = "system:auto-login";

export function createProductionAutoLoginOutcomeHook(auditSink: Pick<AuditSink, "record">) {
  return async ({ bankCode, expiredEventId, runId, outcome }: AutoLoginOutcomeHookMetadata): Promise<void> => {
    const action = outcome.status === "succeeded"
      ? BANK_AUTOLOGIN_ACTIONS.SUCCEEDED
      : outcome.status === "needs_admin_action"
        ? BANK_AUTOLOGIN_ACTIONS.NEEDS_ADMIN_ACTION
        : BANK_AUTOLOGIN_ACTIONS.SKIPPED;
    const reason = outcome.status === "succeeded" ? "succeeded" : outcome.status === "throttled" ? "throttled" : outcome.reason;

    try {
      await auditSink.record(createAuditEvent({
        actorId: SYSTEM_AUTOLOGIN_ACTOR,
        actorRole: null,
        action,
        target: "scrape_run",
        targetId: runId,
        metadata: { bankCode, expiredEventId, runId, reason },
      }));
    } catch {
      // Audit persistence must not affect the protected auto-login flow.
    }
  };
}
