import type {
  SessionAuthenticationAttemptRecord,
  SessionAuthenticationAttemptRepository,
  SessionAuthenticationFailurePair,
  SessionAuthenticationLeaseOwner,
} from "./session-authentication-attempt-repository";
import { parseSessionAuthenticationAttemptRecord } from "./session-authentication-attempt-repository";
import type { SessionAuthenticationAttemptIdentity } from "./session-authentication-attempt";

declare const authenticationMutationAuthorityBrand: unique symbol;
export type AuthenticationMutationAuthority = Readonly<{ readonly [authenticationMutationAuthorityBrand]: never }>;
export type ClaimedAuthenticationMutationAuthority = Readonly<{
  beginCredentialInteraction(): Promise<MutationAuthorityResult>;
  renewLease(): Promise<MutationAuthorityResult>;
  recordSubmitBarrier(): Promise<MutationAuthorityResult>;
  claimRetry(): Promise<MutationAuthorityResult>;
  completeAuthenticated(): Promise<MutationAuthorityCompletionResult>;
  completeFailed(failure: SessionAuthenticationFailurePair): Promise<MutationAuthorityCompletionResult>;
}>;
export type MutationAuthorityResult = Readonly<{ status: "authorized" | "retry_claimed" | "retry_exhausted" | "invalid_sequence" | "unavailable" | "ownership_lost" }>;
export type MutationAuthorityCompletionResult = Readonly<{ status: "completed" | "invalid_sequence" | "unavailable" | "ownership_lost" }>;

type AuthorityState = { repository: SessionAuthenticationAttemptRepository; owner: SessionAuthenticationLeaseOwner; leaseDurationMs: number; claimed: boolean };
type Phase = "leased" | "interaction_started" | "submit_barrier_recorded" | "consumed";
type AuthorityAcquisition =
  | Readonly<{ status: "authentication_required"; authority: AuthenticationMutationAuthority }>
  | Readonly<{ status: "in_progress"; reason: "lease_held" }>
  | Readonly<{ status: "retry_later"; reason: "session_probe_unavailable" | "ownership_changed" | "state_changed" }>
  | Readonly<{ status: "needs_operator_action"; reason: "identity_conflict" | "temporary_authentication_problem" | "protected_authentication_step_detected" | "bank_login_configuration_requires_review" | "authentication_attempt_requires_review" }>
  | Readonly<{ status: "authenticated"; source: "existing" }> | Readonly<{ status: "cancelled" }> | Readonly<{ status: "invalid_request" }>;

const states = new WeakMap<object, AuthorityState>();
const unavailable = (): MutationAuthorityResult => ({ status: "unavailable" });
const invalidSequence = (): MutationAuthorityResult => ({ status: "invalid_sequence" });
const lost = (): MutationAuthorityResult => ({ status: "ownership_lost" });
const completionUnavailable = (): MutationAuthorityCompletionResult => ({ status: "unavailable" });
const completionInvalidSequence = (): MutationAuthorityCompletionResult => ({ status: "invalid_sequence" });
const completionLost = (): MutationAuthorityCompletionResult => ({ status: "ownership_lost" });
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isIdentity = (value: unknown): value is SessionAuthenticationAttemptIdentity => isRecord(value) && [value.bankCode, value.runId, value.attemptId].every((part) => typeof part === "string" && /\S/.test(part));
const parseAttempt = (value: unknown): SessionAuthenticationAttemptRecord | null => !isRecord(value) || !isRecord(value.identity) ? null : parseSessionAuthenticationAttemptRecord({ bankCode: value.identity.bankCode, runId: value.identity.runId, attemptId: value.identity.attemptId, status: value.status, interactionPhase: value.interactionPhase, failureClass: value.failureClass, operatorReason: value.operatorReason, retryCount: value.retryCount, ownerToken: value.ownerToken, generation: value.generation, leaseExpiresAt: value.leaseExpiresAt, terminalAt: value.terminalAt, createdAt: value.createdAt, updatedAt: value.updatedAt });
const isAttempt = (value: unknown): value is SessionAuthenticationAttemptRecord => parseAttempt(value) !== null;
const isProbe = (value: unknown): value is Readonly<{ status: "authenticated"; observedAt: Date }> | Readonly<{ status: "unauthenticated" }> | Readonly<{ status: "unavailable" }> => isRecord(value) && (value.status === "unauthenticated" || value.status === "unavailable" || value.status === "authenticated" && value.observedAt instanceof Date && !Number.isNaN(value.observedAt.getTime()));
const isExact = (value: unknown): value is Awaited<ReturnType<SessionAuthenticationAttemptRepository["findExact"]>> => isRecord(value) && (value.status === "missing" || value.status === "found" && isAttempt(value.record));
const isCreated = (value: unknown): value is Awaited<ReturnType<SessionAuthenticationAttemptRepository["getOrCreate"]>> => isRecord(value) && (value.status === "identity_conflict" && typeof value.existingAttemptId === "string" || (value.status === "created" || value.status === "found") && isAttempt(value.record));
const isLeased = (value: unknown): value is Awaited<ReturnType<SessionAuthenticationAttemptRepository["acquireLease"]>> => isRecord(value) && (value.status === "missing" || value.status === "not_applied" || ((value.status === "lease_held" || value.status === "reconciliation_required" || value.status === "terminal") && isAttempt(value.record)) || value.status === "lease_acquired" && isRecord(value.owner) && isIdentity(value.owner.identity) && typeof value.owner.ownerToken === "string" && typeof value.owner.generation === "bigint" && isAttempt(value.record));
const isReconciled = (value: unknown): value is Awaited<ReturnType<SessionAuthenticationAttemptRepository["reconcileExpiredLease"]>> => isRecord(value) && (value.status === "missing" || value.status === "not_applied" || ((value.status === "lease_reconciled" || value.status === "lease_still_active" || value.status === "unowned" || value.status === "terminal") && isAttempt(value.record)));
const valid = (identity: SessionAuthenticationAttemptIdentity, ownerToken: string, leaseDurationMs: number) =>
  [identity?.bankCode, identity?.runId, identity?.attemptId, ownerToken].every((value) => typeof value === "string" && /\S/.test(value)) && Number.isSafeInteger(leaseDurationMs) && leaseDurationMs > 0;
const terminal = (record: SessionAuthenticationAttemptRecord): AuthorityAcquisition | null => {
  if (record.status === "authenticated") return { status: "authenticated", source: "existing" };
  if (record.status === "failed") return { status: "needs_operator_action", reason: record.operatorReason };
  return null;
};
const sameOwner = (owner: SessionAuthenticationLeaseOwner, record: SessionAuthenticationAttemptRecord, identity: SessionAuthenticationAttemptIdentity, ownerToken: string) =>
  owner.generation >= 0n && owner.identity.bankCode === identity.bankCode && owner.identity.runId === identity.runId && owner.identity.attemptId === identity.attemptId && owner.ownerToken === ownerToken && record.status === "active" && record.identity.bankCode === identity.bankCode && record.identity.runId === identity.runId && record.identity.attemptId === identity.attemptId && record.ownerToken === ownerToken && record.generation === owner.generation && record.leaseExpiresAt instanceof Date;

/** Full probe-and-fenced-lease integration; it is the only authority mint path. */
export async function acquireAuthenticationMutationAuthority(input: Readonly<{
  identity: SessionAuthenticationAttemptIdentity; ownerToken: string; leaseDurationMs: number; signal?: AbortSignal;
  repository: SessionAuthenticationAttemptRepository;
  probe: Readonly<{ observe(input: Readonly<{ bankCode: string; signal?: AbortSignal }>): Promise<Readonly<{ status: "authenticated"; observedAt: Date }> | Readonly<{ status: "unauthenticated" }> | Readonly<{ status: "unavailable" }>> }>;
}>): Promise<AuthorityAcquisition> {
  const { identity, ownerToken, leaseDurationMs, signal, repository, probe } = input;
  if (!valid(identity, ownerToken, leaseDurationMs)) return { status: "invalid_request" };
  if (signal?.aborted) return { status: "cancelled" };
  let reconciled = false;
  while (true) {
    let exact: unknown;
    try { exact = await repository.findExact({ identity }); } catch { return { status: "retry_later", reason: "state_changed" }; }
    if (!isExact(exact)) return { status: "retry_later", reason: "state_changed" };
    if (exact.status === "found") {
      const resolved = terminal(exact.record); if (resolved) return resolved;
      if (exact.record.ownerToken !== null) return { status: "in_progress", reason: "lease_held" };
    }
    let observation: unknown;
    try { observation = await probe.observe({ bankCode: identity.bankCode, signal }); } catch { return { status: "retry_later", reason: "session_probe_unavailable" }; }
    if (signal?.aborted) return { status: "cancelled" };
    if (!isProbe(observation)) return { status: "retry_later", reason: "session_probe_unavailable" };
    if (observation.status !== "unauthenticated") return { status: "retry_later", reason: observation.status === "unavailable" ? "session_probe_unavailable" : "state_changed" };
    let created: unknown;
    try { created = await repository.getOrCreate({ identity }); } catch { return { status: "retry_later", reason: "state_changed" }; }
    if (!isCreated(created)) return { status: "retry_later", reason: "state_changed" };
    if (created.status === "identity_conflict") return { status: "needs_operator_action", reason: "identity_conflict" };
    const resolved = terminal(created.record); if (resolved) return resolved;
    if (created.record.ownerToken !== null) return { status: "in_progress", reason: "lease_held" };
    let leased: unknown;
    try { leased = await repository.acquireLease({ identity, ownerToken, leaseDurationMs }); } catch { return { status: "retry_later", reason: "state_changed" }; }
    if (!isLeased(leased)) return { status: "retry_later", reason: "state_changed" };
    if (leased.status === "lease_held") return { status: "in_progress", reason: "lease_held" };
    if (leased.status === "terminal") return terminal(leased.record) ?? { status: "retry_later", reason: "state_changed" };
    if (leased.status === "missing" || leased.status === "not_applied") return { status: "retry_later", reason: "state_changed" };
    if (leased.status === "reconciliation_required") {
      if (reconciled) return { status: "retry_later", reason: "state_changed" };
      reconciled = true;
      try {
        const result: unknown = await repository.reconcileExpiredLease({ identity });
        if (!isReconciled(result)) return { status: "retry_later", reason: "state_changed" };
        if (result.status === "terminal") return terminal(result.record) ?? { status: "retry_later", reason: "state_changed" };
        if (result.status === "lease_still_active") return { status: "in_progress", reason: "lease_held" };
        if (result.status === "missing" || result.status === "not_applied") return { status: "retry_later", reason: "state_changed" };
      } catch { return { status: "retry_later", reason: "state_changed" }; }
      continue;
    }
    if (!sameOwner(leased.owner, leased.record, identity, ownerToken)) return { status: "retry_later", reason: "ownership_changed" };
    const authority = Object.freeze(Object.create(null)) as AuthenticationMutationAuthority;
    states.set(authority, { repository, owner: leased.owner, leaseDurationMs, claimed: false });
    return { status: "authentication_required", authority };
  }
}

export function claimAuthenticationMutationAuthority(authority: AuthenticationMutationAuthority): Readonly<{ status: "claimed"; authority: ClaimedAuthenticationMutationAuthority }> | Readonly<{ status: "unavailable" }> {
  const state = states.get(authority as object);
  if (!state || state.claimed) return { status: "unavailable" };
  state.claimed = true;
  let phase: Phase = "leased";
  let pending = false;
  const poison = () => { phase = "consumed"; pending = false; };
  const active = (value: unknown, interactionPhase: string) => {
    const record = parseAttempt(value);
    return record?.status === "active" && record.interactionPhase === interactionPhase && record.identity.bankCode === state.owner.identity.bankCode && record.identity.runId === state.owner.identity.runId && record.identity.attemptId === state.owner.identity.attemptId && record.ownerToken === state.owner.ownerToken && record.generation === state.owner.generation && record.leaseExpiresAt instanceof Date;
  };
  const terminal = (value: unknown, status: "authenticated" | "failed", failure?: SessionAuthenticationFailurePair) => {
    const record = parseAttempt(value);
    return record?.status === status && record.identity.bankCode === state.owner.identity.bankCode && record.identity.runId === state.owner.identity.runId && record.identity.attemptId === state.owner.identity.attemptId && record.ownerToken === null && record.leaseExpiresAt === null && record.generation === state.owner.generation + 1n && record.terminalAt instanceof Date && (!failure || record.status === "failed" && record.failureClass === failure.failureClass && record.operatorReason === failure.operatorReason);
  };
  const retryClaimed = (value: unknown) => {
    if (!isRecord(value) || value.status !== "retry_claimed" || (value.retryCount !== 1 && value.retryCount !== 2)) return false;
    const record = parseAttempt(value.record);
    return record?.status === "active" && record.identity.bankCode === state.owner.identity.bankCode && record.identity.runId === state.owner.identity.runId && record.identity.attemptId === state.owner.identity.attemptId && record.ownerToken === null && record.leaseExpiresAt === null && record.failureClass === null && record.operatorReason === null && record.terminalAt === null && record.generation === state.owner.generation + 1n && record.retryCount === value.retryCount;
  };
  const run = async (allowed: Phase, call: () => Promise<unknown>, next: Phase, expectedStatus: string): Promise<MutationAuthorityResult> => {
    if (phase !== allowed || pending) return invalidSequence();
    pending = true;
    try {
      const result = await call(); pending = false;
      if (!isRecord(result) || typeof result.status !== "string") { poison(); return unavailable(); }
      if (result.status === "stale_owner" || result.status === "lease_expired") { poison(); return lost(); }
      const expected = next === "interaction_started" ? "credentials_may_have_reached_portal" : "submit_may_have_been_dispatched";
      if (result.status !== expectedStatus || !active(result.record, expected)) { poison(); return unavailable(); }
      phase = next; return { status: "authorized" };
    } catch { poison(); return unavailable(); }
  };
  const renew = async (): Promise<MutationAuthorityResult> => {
    if (phase === "consumed" || pending) return invalidSequence();
    const expected = phase === "leased" ? "no_credential_interaction" : phase === "interaction_started" ? "credentials_may_have_reached_portal" : "submit_may_have_been_dispatched";
    pending = true;
    try {
      const result = await state.repository.renewLease({ owner: state.owner, leaseDurationMs: state.leaseDurationMs }); pending = false;
      if (!isRecord(result) || typeof result.status !== "string") { poison(); return unavailable(); }
      if (result.status === "stale_owner" || result.status === "lease_expired") { poison(); return lost(); }
      if (result.status !== "lease_renewed" || !active(result.record, expected)) { poison(); return unavailable(); }
      return { status: "authorized" };
    } catch { poison(); return unavailable(); }
  };
  const complete = async (call: () => Promise<unknown>, failure?: SessionAuthenticationFailurePair): Promise<MutationAuthorityCompletionResult> => {
    if (phase === "consumed" || pending) return completionInvalidSequence();
    phase = "consumed"; pending = true;
    try {
      const result = await call(); pending = false;
      if (!isRecord(result)) return completionUnavailable();
      if (result.status === "stale_owner" || result.status === "lease_expired") return completionLost();
      return result.status === "authenticated" && terminal(result.record, "authenticated") || result.status === "failed" && terminal(result.record, "failed", failure) ? { status: "completed" } : completionUnavailable();
    } catch { pending = false; return completionUnavailable(); }
  };
  const claimRetry = async (): Promise<MutationAuthorityResult> => {
    if (phase !== "leased" || pending) return invalidSequence();
    phase = "consumed"; pending = true;
    try {
      const result: unknown = await state.repository.claimRetry({ owner: state.owner }); pending = false;
      if (!isRecord(result)) return unavailable();
      if (result.status === "retry_exhausted") return { status: "retry_exhausted" };
      if (retryClaimed(result)) return { status: "retry_claimed" };
      if (result.status === "stale_owner" || result.status === "lease_expired") return lost();
      return unavailable();
    } catch { pending = false; return unavailable(); }
  };
  return { status: "claimed", authority: Object.freeze({
    beginCredentialInteraction: () => run("leased", () => state.repository.beginCredentialInteraction({ owner: state.owner, leaseDurationMs: state.leaseDurationMs }), "interaction_started", "interaction_started"),
    renewLease: renew,
    recordSubmitBarrier: () => run("interaction_started", () => state.repository.recordSubmitBarrier({ owner: state.owner, leaseDurationMs: state.leaseDurationMs }), "submit_barrier_recorded", "recorded"),
    claimRetry,
    completeAuthenticated: () => complete(() => state.repository.completeAuthenticated({ owner: state.owner })),
    completeFailed: (failure) => complete(() => state.repository.completeFailed({ owner: state.owner, ...failure }), failure),
  }) };
}
