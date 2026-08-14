import type {
  CredentialInteractionPhase,
  SessionAuthenticationAttemptIdentity,
  SessionAuthenticationFailureClass,
  SessionAuthenticationOperatorReason,
} from "./session-authentication-attempt";

export type SessionAuthenticationAttemptRow = Readonly<{
  bankCode: unknown; runId: unknown; attemptId: unknown; status: unknown; interactionPhase: unknown;
  failureClass: unknown; operatorReason: unknown; retryCount: unknown; ownerToken: unknown;
  generation: unknown; leaseExpiresAt: unknown; terminalAt: unknown; createdAt: unknown; updatedAt: unknown;
}>;

type RecordFields = Readonly<{
  identity: SessionAuthenticationAttemptIdentity;
  interactionPhase: CredentialInteractionPhase;
  retryCount: number;
  generation: bigint;
  createdAt: Date;
  updatedAt: Date;
}>;

type ActiveOwnership =
  | Readonly<{ ownerToken: null; leaseExpiresAt: null }>
  | Readonly<{ ownerToken: string; leaseExpiresAt: Date }>;

export type SessionAuthenticationFailurePair =
  | Readonly<{ failureClass: "transient_pre_interaction"; operatorReason: "temporary_authentication_problem" }>
  | Readonly<{ failureClass: "protected_or_mfa"; operatorReason: "protected_authentication_step_detected" }>
  | Readonly<{ failureClass: "incompatible_flow" | "structural_configuration"; operatorReason: "bank_login_configuration_requires_review" }>
  | Readonly<{ failureClass: "ownership_lost" | "interaction_outcome_uncertain" | "unclassified_failure"; operatorReason: "authentication_attempt_requires_review" }>;

export type SessionAuthenticationAttemptRecord =
  | (RecordFields & ActiveOwnership & Readonly<{ status: "active"; failureClass: null; operatorReason: null; terminalAt: null }>)
  | (RecordFields & Readonly<{ status: "authenticated"; ownerToken: null; leaseExpiresAt: null; failureClass: null; operatorReason: null; terminalAt: Date }>)
  | (RecordFields & SessionAuthenticationFailurePair & Readonly<{ status: "failed"; ownerToken: null; leaseExpiresAt: null; terminalAt: Date }>);

export type SessionAuthenticationLeaseOwner = Readonly<{
  identity: SessionAuthenticationAttemptIdentity;
  ownerToken: string;
  generation: bigint;
}>;

export type GetOrCreateSessionAuthenticationAttemptInput = Readonly<{ identity: SessionAuthenticationAttemptIdentity }>;
export type FindExactSessionAuthenticationAttemptInput = Readonly<{ identity: SessionAuthenticationAttemptIdentity }>;
export type AcquireSessionAuthenticationLeaseInput = Readonly<{ identity: SessionAuthenticationAttemptIdentity; ownerToken: string; leaseDurationMs: number }>;
export type RenewSessionAuthenticationLeaseInput = Readonly<{ owner: SessionAuthenticationLeaseOwner; leaseDurationMs: number }>;
export type BeginCredentialInteractionInput = Readonly<{ owner: SessionAuthenticationLeaseOwner }>;
export type RecordSubmitBarrierInput = Readonly<{ owner: SessionAuthenticationLeaseOwner }>;
export type ClaimRetryInput = Readonly<{ owner: SessionAuthenticationLeaseOwner }>;
// PostgreSQL is the authoritative clock for terminal and lease timestamps.
export type CompleteAuthenticatedInput = Readonly<{ owner: SessionAuthenticationLeaseOwner }>;
export type CompleteFailedInput = Readonly<{ owner: SessionAuthenticationLeaseOwner } & SessionAuthenticationFailurePair>;
export type ReconcileExpiredLeaseInput = Readonly<{ identity: SessionAuthenticationAttemptIdentity }>;
export type ObservedRestorationEvidence = Readonly<{ authenticatedAt: Date }>;
export type ResolveObservedRestorationResult =
  | Readonly<{ status: "resolved"; evidence: ObservedRestorationEvidence }>
  | Readonly<{ status: "already_resolved" }>
  | Readonly<{ status: "missing"; missing: "authentication_attempt" | "expiry_episode" }>
  | Readonly<{ status: "identity_mismatch" | "stale_owner" | "lease_expired" | "active_mutation_owner" | "episode_not_resolvable" | "terminal_conflict" }>
  | SessionAuthenticationAttemptNotAppliedResult;

export type GetOrCreateSessionAuthenticationAttemptResult =
  | Readonly<{ status: "created"; record: SessionAuthenticationAttemptRecord }>
  | Readonly<{ status: "found"; record: SessionAuthenticationAttemptRecord }>
  /** Same bank/run already exists under a different attemptId; fail closed and do not perform bank mutation. */
  | Readonly<{ status: "identity_conflict"; existingAttemptId: string }>;
export type FindExactSessionAuthenticationAttemptResult =
  | Readonly<{ status: "found"; record: SessionAuthenticationAttemptRecord }>
  | Readonly<{ status: "missing" }>;
/** No state transition was proven; caller must refetch/re-evaluate and MUST NOT perform bank mutation. */
export type SessionAuthenticationAttemptNotAppliedResult = Readonly<{ status: "not_applied" }>;
export type AcquireSessionAuthenticationLeaseResult =
  | Readonly<{ status: "lease_acquired"; owner: SessionAuthenticationLeaseOwner; record: SessionAuthenticationAttemptRecord }>
  | Readonly<{ status: "lease_held"; record: SessionAuthenticationAttemptRecord }>
  /** Lease is expired but ownership/phase must be reconciled; caller must not proceed or perform bank mutation. */
  | Readonly<{ status: "reconciliation_required"; record: SessionAuthenticationAttemptRecord }>
  | Readonly<{ status: "terminal"; record: SessionAuthenticationAttemptRecord }>
  | Readonly<{ status: "missing" }>
  | SessionAuthenticationAttemptNotAppliedResult;
export type RenewSessionAuthenticationLeaseResult =
  | Readonly<{ status: "lease_renewed"; record: SessionAuthenticationAttemptRecord }>
  | Readonly<{ status: "stale_owner" }>
  | Readonly<{ status: "lease_expired" }>
  | Readonly<{ status: "terminal" }>
  | Readonly<{ status: "missing" }>
  | SessionAuthenticationAttemptNotAppliedResult;
export type BeginCredentialInteractionResult =
  | Readonly<{ status: "interaction_started"; record: SessionAuthenticationAttemptRecord }>
  | Readonly<{ status: "already_started"; record: SessionAuthenticationAttemptRecord }>
  | Readonly<{ status: "stale_owner" }>
  | Readonly<{ status: "lease_expired" }>
  | Readonly<{ status: "terminal" }>
  | Readonly<{ status: "missing" }>
  | SessionAuthenticationAttemptNotAppliedResult;
/** Only `recorded` authorizes a future credential-submit click. */
export type RecordSessionAuthenticationSubmitBarrierResult =
  | Readonly<{ status: "recorded"; record: SessionAuthenticationAttemptRecord }>
  | Readonly<{ status: "already_recorded"; record: SessionAuthenticationAttemptRecord }>
  | Readonly<{ status: "invalid_transition" }>
  | Readonly<{ status: "stale_owner" }>
  | Readonly<{ status: "lease_expired" }>
  | Readonly<{ status: "terminal" }>
  | Readonly<{ status: "missing" }>
  | SessionAuthenticationAttemptNotAppliedResult;
export type ClaimSessionAuthenticationRetryResult =
  | Readonly<{ status: "retry_claimed"; retryCount: 1 | 2; record: SessionAuthenticationAttemptRecord }>
  | Readonly<{ status: "retry_exhausted" }>
  | Readonly<{ status: "ineligible" }>
  | Readonly<{ status: "stale_owner" }>
  | Readonly<{ status: "lease_expired" }>
  | Readonly<{ status: "terminal" }>
  | Readonly<{ status: "missing" }>
  | SessionAuthenticationAttemptNotAppliedResult;
export type CompleteAuthenticatedResult =
  | Readonly<{ status: "authenticated"; record: SessionAuthenticationAttemptRecord }>
  | Readonly<{ status: "invalid_transition" }>
  | Readonly<{ status: "stale_owner" }>
  | Readonly<{ status: "lease_expired" }>
  | Readonly<{ status: "terminal" }>
  | Readonly<{ status: "missing" }>
  | SessionAuthenticationAttemptNotAppliedResult;
export type CompleteFailedResult =
  | Readonly<{ status: "failed"; record: SessionAuthenticationAttemptRecord }>
  | Readonly<{ status: "stale_owner" }>
  | Readonly<{ status: "lease_expired" }>
  | Readonly<{ status: "terminal" }>
  | Readonly<{ status: "missing" }>
  | SessionAuthenticationAttemptNotAppliedResult;
export type ReconcileExpiredLeaseResult =
  | Readonly<{ status: "lease_reconciled"; record: SessionAuthenticationAttemptRecord }>
  | Readonly<{ status: "lease_still_active"; record: SessionAuthenticationAttemptRecord }>
  | Readonly<{ status: "unowned"; record: SessionAuthenticationAttemptRecord }>
  | Readonly<{ status: "terminal"; record: SessionAuthenticationAttemptRecord }>
  | Readonly<{ status: "missing" }>
  | SessionAuthenticationAttemptNotAppliedResult;

export interface SessionAuthenticationAttemptRepository {
  getOrCreate(input: GetOrCreateSessionAuthenticationAttemptInput): Promise<GetOrCreateSessionAuthenticationAttemptResult>;
  findExact(input: FindExactSessionAuthenticationAttemptInput): Promise<FindExactSessionAuthenticationAttemptResult>;
  acquireLease(input: AcquireSessionAuthenticationLeaseInput): Promise<AcquireSessionAuthenticationLeaseResult>;
  renewLease(input: RenewSessionAuthenticationLeaseInput): Promise<RenewSessionAuthenticationLeaseResult>;
  beginCredentialInteraction(input: BeginCredentialInteractionInput): Promise<BeginCredentialInteractionResult>;
  recordSubmitBarrier(input: RecordSubmitBarrierInput): Promise<RecordSessionAuthenticationSubmitBarrierResult>;
  claimRetry(input: ClaimRetryInput): Promise<ClaimSessionAuthenticationRetryResult>;
  completeAuthenticated(input: CompleteAuthenticatedInput): Promise<CompleteAuthenticatedResult>;
  completeFailed(input: CompleteFailedInput): Promise<CompleteFailedResult>;
  reconcileExpiredLease(input: ReconcileExpiredLeaseInput): Promise<ReconcileExpiredLeaseResult>;
}
/** Atomic, production-inert capability for durable observed-restoration evidence. */
export interface ObservedRestorationResolver {
  resolveObservedRestoration(owner: SessionAuthenticationLeaseOwner): Promise<ResolveObservedRestorationResult>;
}

const phases: readonly CredentialInteractionPhase[] = ["no_credential_interaction", "credentials_may_have_reached_portal", "submit_may_have_been_dispatched"];
const failureClasses: readonly SessionAuthenticationFailureClass[] = ["transient_pre_interaction", "protected_or_mfa", "incompatible_flow", "structural_configuration", "ownership_lost", "interaction_outcome_uncertain", "unclassified_failure"];
const operatorReasons: readonly SessionAuthenticationOperatorReason[] = ["temporary_authentication_problem", "protected_authentication_step_detected", "bank_login_configuration_requires_review", "authentication_attempt_requires_review"];

export function parseSessionAuthenticationAttemptRecord(row: SessionAuthenticationAttemptRow): SessionAuthenticationAttemptRecord | null {
  if (![row.bankCode, row.runId, row.attemptId].every(isNonblankString) || !phases.includes(row.interactionPhase as CredentialInteractionPhase)
    || !Number.isInteger(row.retryCount) || (row.retryCount as number) < 0 || (row.retryCount as number) > 2
    || typeof row.generation !== "bigint" || row.generation < 0n || !isDate(row.createdAt) || !isDate(row.updatedAt)) return null;
  const fields: RecordFields = { identity: { bankCode: row.bankCode as string, runId: row.runId as string, attemptId: row.attemptId as string }, interactionPhase: row.interactionPhase as CredentialInteractionPhase, retryCount: row.retryCount as number, generation: row.generation, createdAt: row.createdAt, updatedAt: row.updatedAt };
  if (row.status === "active" && row.failureClass === null && row.operatorReason === null && row.terminalAt === null) {
    if (row.ownerToken === null && row.leaseExpiresAt === null) return { ...fields, status: "active", ownerToken: null, leaseExpiresAt: null, failureClass: null, operatorReason: null, terminalAt: null };
    if (isNonblankString(row.ownerToken) && isDate(row.leaseExpiresAt)) return { ...fields, status: "active", ownerToken: row.ownerToken, leaseExpiresAt: row.leaseExpiresAt, failureClass: null, operatorReason: null, terminalAt: null };
  }
  if (row.status === "authenticated" && row.ownerToken === null && row.leaseExpiresAt === null && row.failureClass === null && row.operatorReason === null && isDate(row.terminalAt)) return { ...fields, status: "authenticated", ownerToken: null, leaseExpiresAt: null, failureClass: null, operatorReason: null, terminalAt: row.terminalAt };
  const failurePair = parseFailurePair(row.failureClass, row.operatorReason);
  if (row.status === "failed" && row.ownerToken === null && row.leaseExpiresAt === null && failurePair && isDate(row.terminalAt)) return { ...fields, status: "failed", ownerToken: null, leaseExpiresAt: null, ...failurePair, terminalAt: row.terminalAt };
  return null;
}

function isNonblankString(value: unknown): value is string { return typeof value === "string" && /\S/.test(value); }
function isDate(value: unknown): value is Date { return value instanceof Date && !Number.isNaN(value.getTime()); }
function parseFailurePair(failureClass: unknown, operatorReason: unknown): SessionAuthenticationFailurePair | null {
  if (!failureClasses.includes(failureClass as SessionAuthenticationFailureClass) || !operatorReasons.includes(operatorReason as SessionAuthenticationOperatorReason)) return null;
  if (failureClass === "transient_pre_interaction" && operatorReason === "temporary_authentication_problem") return { failureClass, operatorReason };
  if (failureClass === "protected_or_mfa" && operatorReason === "protected_authentication_step_detected") return { failureClass, operatorReason };
  if ((failureClass === "incompatible_flow" || failureClass === "structural_configuration") && operatorReason === "bank_login_configuration_requires_review") return { failureClass, operatorReason };
  if ((failureClass === "ownership_lost" || failureClass === "interaction_outcome_uncertain" || failureClass === "unclassified_failure") && operatorReason === "authentication_attempt_requires_review") return { failureClass, operatorReason };
  return null;
}
