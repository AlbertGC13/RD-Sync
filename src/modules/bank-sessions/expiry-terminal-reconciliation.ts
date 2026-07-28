import type { AuditEvent } from "../audit";
import type { ExpiryPublicationEnvelope } from "./expiry-episodes";

export type ExpiryTerminalFailureReason = "job_failed" | "job_missing";
export type ExpiryTerminalObservation =
  | { kind: "terminal"; reason: ExpiryTerminalFailureReason }
  | { kind: "non_terminal"; state: "waiting" | "active" | "delayed" | "prioritized" | "waiting-children" | "completed" }
  | { kind: "observation_rejected"; operatorSignal: typeof EXPIRY_OBSERVATION_REJECTED_SIGNAL; retryable: true };
export type ExpiryTerminalReconciliationResult = { status: "reconciled" | "already_reconciled" | "ignored_stale_envelope"; operatorSignal: typeof EXPIRY_TERMINAL_OPERATOR_SIGNAL; audit?: AuditEvent };

export const EXPIRY_OBSERVATION_REJECTED_SIGNAL = "Expiry recovery status could not be verified";
export const EXPIRY_TERMINAL_OPERATOR_SIGNAL = "Automatic session recovery requires administrative review";

export interface ExpiryTerminalReconciliationRepository {
  reconcileTerminalFailure(envelope: ExpiryPublicationEnvelope, reason: ExpiryTerminalFailureReason, reconciledAt: Date): Promise<ExpiryTerminalReconciliationResult>;
}

export function classifyExpiryTerminalObservation(value: unknown): ExpiryTerminalObservation {
  if (value === "failed") return { kind: "terminal", reason: "job_failed" };
  if (value === "missing") return { kind: "terminal", reason: "job_missing" };
  if (["waiting", "active", "delayed", "prioritized", "waiting-children", "completed"].includes(String(value))) {
    return { kind: "non_terminal", state: value as Extract<ExpiryTerminalObservation, { kind: "non_terminal" }>["state"] };
  }
  return { kind: "observation_rejected", operatorSignal: EXPIRY_OBSERVATION_REJECTED_SIGNAL, retryable: true };
}

export async function reconcileExpiryTerminalObservation(
  observe: () => Promise<unknown>, repository: ExpiryTerminalReconciliationRepository, envelope: ExpiryPublicationEnvelope, clock: () => Date = () => new Date(),
): Promise<Exclude<ExpiryTerminalObservation, { kind: "terminal" }> | { kind: "terminal"; reason: ExpiryTerminalFailureReason; result: ExpiryTerminalReconciliationResult }> {
  let observation: ExpiryTerminalObservation;
  try { observation = classifyExpiryTerminalObservation(await observe()); }
  catch { return { kind: "observation_rejected", operatorSignal: EXPIRY_OBSERVATION_REJECTED_SIGNAL, retryable: true }; }
  if (observation.kind !== "terminal") return observation;
  return { ...observation, result: await repository.reconcileTerminalFailure(envelope, observation.reason, clock()) };
}

export function createExpiryTerminalAudit(
  envelope: Pick<ExpiryPublicationEnvelope, "bankCode" | "expiredEventId" | "runId">,
  reason: ExpiryTerminalFailureReason,
  reconciledAt: Date,
  requiresManualRecovery: boolean,
): AuditEvent {
  const identity = `${envelope.bankCode}:${envelope.expiredEventId}:${envelope.runId}`;
  return {
    id: `bank-session-expiry-terminal:${identity}`,
    actorId: "system", actorRole: "system",
    action: requiresManualRecovery ? "manual_recovery_required" : "needs_admin_action",
    target: "bank_session_expiry_episode", targetId: identity,
    metadata: { bankCode: envelope.bankCode, expiredEventId: envelope.expiredEventId, runId: envelope.runId, reason, reconciledAt: reconciledAt.toISOString() },
    createdAt: reconciledAt,
  };
}
