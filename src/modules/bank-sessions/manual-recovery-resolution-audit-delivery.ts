import type { AuditEvent, AuditSink } from "../audit";
import { createManualRecoveryResolutionAuditMetadata, type ManualRecoveryResolutionDecision } from "./manual-recovery-resolution";

export interface ManualRecoveryResolutionAuditOutbox {
  id: string;
  state: "pending" | "delivering" | "delivered";
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  deliveredAt: Date | null;
  resolution: ManualRecoveryResolutionAuditResolution;
}

export interface ManualRecoveryResolutionAuditResolution {
  id: string;
  bankCode: string;
  expiredEventId: string;
  runId: string;
  outcome: ManualRecoveryResolutionDecision["outcome"];
  reason: ManualRecoveryResolutionDecision["reason"];
  operatorId: string;
  resolvedAt: Date;
}

export interface ManualRecoveryResolutionAuditOutboxRepository {
  findClaimable(): Promise<ManualRecoveryResolutionAuditOutbox | null>;
  claim(id: string, leaseOwner: string, leaseMs: number): Promise<boolean>;
  markDelivered(id: string, leaseOwner: string): Promise<boolean>;
  releaseClaim(id: string, leaseOwner: string): Promise<boolean>;
  inspect(id: string): Promise<ManualRecoveryResolutionAuditOutbox | null>;
}

export function createManualRecoveryResolutionAuditEvent(resolution: ManualRecoveryResolutionAuditResolution): AuditEvent {
  const decision: ManualRecoveryResolutionDecision = { outcome: resolution.outcome, reason: resolution.reason } as ManualRecoveryResolutionDecision;
  return { id: `bank-autologin-manual-recovery-resolved:${resolution.id}`, actorId: resolution.operatorId, actorRole: "admin", action: "bank_autologin.manual_recovery_resolved", target: "manual_recovery_resolution", targetId: resolution.id,
    metadata: createManualRecoveryResolutionAuditMetadata({ bankCode: resolution.bankCode, expiredEventId: resolution.expiredEventId, runId: resolution.runId, decision, operatorId: resolution.operatorId, resolvedAt: resolution.resolvedAt.toISOString() }), createdAt: resolution.resolvedAt };
}

export async function deliverManualRecoveryResolutionAudit(repository: ManualRecoveryResolutionAuditOutboxRepository, auditSink: AuditSink, leaseOwner: string, leaseMs: number): Promise<boolean> {
  if (!leaseOwner.trim()) throw new Error("Audit delivery lease owner must be nonblank");
  if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error("Audit delivery lease duration must be positive");
  const outbox = await repository.findClaimable();
  if (!outbox || !await repository.claim(outbox.id, leaseOwner, leaseMs)) return false;
  try {
    await auditSink.record(createManualRecoveryResolutionAuditEvent(outbox.resolution));
  } catch (sinkError) {
    try { await repository.releaseClaim(outbox.id, leaseOwner); }
    catch (releaseError) { throw new AggregateError([sinkError, releaseError], "Manual recovery audit delivery and release failed"); }
    throw sinkError;
  }
  if (!await repository.markDelivered(outbox.id, leaseOwner)) throw new Error("Manual recovery audit delivery acknowledgement lost");
  return true;
}
