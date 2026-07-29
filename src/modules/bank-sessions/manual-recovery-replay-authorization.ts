import { randomUUID } from "node:crypto";

import type { AuditEvent } from "../audit";
import { createExpiredSessionRunId } from "./index";

export type ManualRecoveryReplayAuthorizationStatus = "authorized" | "already_authorized" | "ineligible";
export interface ManualRecoveryReplayAuthorizationCandidate { resolutionId: string; replayExpiredEventId: string; replayRunId: string; authorizedAt: Date; }
export interface ManualRecoveryReplayAuthorizationResult { status: ManualRecoveryReplayAuthorizationStatus; replayExpiredEventId?: string; replayRunId?: string; audit?: AuditEvent; }
export interface ManualRecoveryReplayAuthorizationRepository {
  findManualRecoveryReplayBankCode(resolutionId: string): Promise<string | null>;
  authorizeManualRecoveryReplay(candidate: ManualRecoveryReplayAuthorizationCandidate): Promise<ManualRecoveryReplayAuthorizationResult>;
}
export interface ManualRecoveryReplayAuthorizationDeps {
  repository: ManualRecoveryReplayAuthorizationRepository;
  createExpiredEventId?: () => string;
  createRunId?: (bankCode: string, expiredEventId: string) => string;
  clock?: () => Date;
}

export function createManualRecoveryReplayAuthorization({ repository, createExpiredEventId = randomUUID, createRunId = createExpiredSessionRunId, clock = () => new Date() }: ManualRecoveryReplayAuthorizationDeps) {
  return { async authorize(resolutionId: string): Promise<ManualRecoveryReplayAuthorizationResult> {
    if (!resolutionId.trim()) throw new Error("Manual recovery resolution ID must be nonblank");
    const bankCode = await repository.findManualRecoveryReplayBankCode(resolutionId);
    if (!bankCode) return { status: "ineligible" };
    const replayExpiredEventId = createExpiredEventId();
    return repository.authorizeManualRecoveryReplay({ resolutionId, replayExpiredEventId, replayRunId: createRunId(bankCode, replayExpiredEventId), authorizedAt: clock() });
  } };
}

export function createManualRecoveryReplayAuthorizedAudit(resolutionId: string, operatorId: string, replayExpiredEventId: string, replayRunId: string, createdAt: Date): AuditEvent {
  return {
    id: `bank-autologin-replay-authorized:${resolutionId}`,
    actorId: operatorId, actorRole: "admin", action: "bank_autologin.replay_authorized", target: "manual_recovery_resolution", targetId: resolutionId,
    metadata: { replayExpiredEventId, replayRunId }, createdAt,
  };
}
