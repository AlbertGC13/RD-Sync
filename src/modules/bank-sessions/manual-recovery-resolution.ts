export type ManualRecoveryResolutionDecision =
  | { readonly outcome: "safe_to_retry"; readonly reason: "verified_no_mutation" }
  | { readonly outcome: "mutation_confirmed"; readonly reason: "verified_mutation" }
  | { readonly outcome: "resolved_no_retry"; readonly reason: "closed_without_retry" };

export interface ManualRecoveryResolutionActor {
  operatorId: string;
  roles: readonly string[];
}

export interface ManualRecoveryResolutionRequest {
  actor: ManualRecoveryResolutionActor;
  decision: ManualRecoveryResolutionDecision;
}

export interface ManualRecoveryResolutionCommand {
  readonly operatorId: string;
  readonly decision: ManualRecoveryResolutionDecision;
}

export interface ManualRecoveryResolutionRateLimitGate {
  allow(operatorId: string): Promise<boolean>;
}

export interface ManualRecoveryResolutionAuditMetadataInput {
  bankCode: string;
  expiredEventId: string;
  runId: string;
  decision: ManualRecoveryResolutionDecision;
  operatorId: string;
  resolvedAt: string;
  [key: string]: unknown;
}

export async function authorizeManualRecoveryResolution(
  request: ManualRecoveryResolutionRequest,
  rateLimitGate: ManualRecoveryResolutionRateLimitGate,
): Promise<ManualRecoveryResolutionCommand> {
  const operatorId = request.actor.operatorId.trim();
  if (!operatorId) throw new Error("Manual recovery operator ID must be nonblank");
  if (!request.actor.roles.includes("admin")) throw new Error("Admin role required for manual recovery resolution");
  const decision = parseManualRecoveryResolutionDecision(request.decision);
  if (!await rateLimitGate.allow(operatorId)) throw new Error("Manual recovery resolution rate limited");

  return Object.freeze({
    operatorId,
    decision: Object.freeze(decision),
  });
}

export function createManualRecoveryResolutionAuditMetadata(
  input: ManualRecoveryResolutionAuditMetadataInput,
): Record<string, string> {
  return {
    bankCode: input.bankCode,
    expiredEventId: input.expiredEventId,
    runId: input.runId,
    outcome: input.decision.outcome,
    operatorId: input.operatorId,
    reason: input.decision.reason,
    resolvedAt: input.resolvedAt,
  };
}

function parseManualRecoveryResolutionDecision(value: unknown): ManualRecoveryResolutionDecision {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Manual recovery decision is invalid");
  }

  const decision = value as Record<string, unknown>;
  if (decision.outcome === "safe_to_retry" && decision.reason === "verified_no_mutation") {
    return { outcome: "safe_to_retry", reason: "verified_no_mutation" };
  }
  if (decision.outcome === "mutation_confirmed" && decision.reason === "verified_mutation") {
    return { outcome: "mutation_confirmed", reason: "verified_mutation" };
  }
  if (decision.outcome === "resolved_no_retry" && decision.reason === "closed_without_retry") {
    return { outcome: "resolved_no_retry", reason: "closed_without_retry" };
  }
  throw new Error("Manual recovery decision is invalid");
}
