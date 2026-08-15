import type {
  ObservedRestorationResolver,
  SessionAuthenticationAttemptRecord,
  SessionAuthenticationAttemptRepository,
} from "./session-authentication-attempt-repository";
import { parseSessionAuthenticationAttemptRecord } from "./session-authentication-attempt-repository";
import type { SessionAuthenticationAttemptIdentity, SessionAuthenticationOperatorReason } from "./session-authentication-attempt";
import { acquireAuthenticationMutationAuthority } from "./authentication-mutation-authority";
import type { AuthenticationMutationAuthority } from "./authentication-mutation-authority";

export interface AuthenticatedSessionProbe {
  observe(input: Readonly<{ bankCode: string; signal?: AbortSignal }>): Promise<
    | Readonly<{ status: "authenticated"; observedAt: Date }>
    | Readonly<{ status: "unauthenticated" }>
    | Readonly<{ status: "unavailable" }>
  >;
}

type Attempts = SessionAuthenticationAttemptRepository;
export type AuthenticatedSessionCompletion =
  | Readonly<{ mode: "attempt_only" }>
  | Readonly<{ mode: "expiry_restoration"; resolver: ObservedRestorationResolver }>;
export type AuthenticatedSessionCoordinatorDependencies = Readonly<{ attempts: Attempts; probe: AuthenticatedSessionProbe; completion: AuthenticatedSessionCompletion }>;
export type CoordinateAuthenticatedSessionStateInput = Readonly<{ identity: SessionAuthenticationAttemptIdentity; ownerToken: string; leaseDurationMs: number; signal?: AbortSignal }>;
export type AuthenticatedSessionState =
  | Readonly<{ status: "authenticated"; source: "existing" | "observed" }>
  | Readonly<{ status: "authentication_required"; authority: AuthenticationMutationAuthority }>
  | Readonly<{ status: "in_progress"; reason: "lease_held" | "active_mutation_owner" }>
  | Readonly<{ status: "retry_later"; reason: "session_probe_unavailable" | "ownership_changed" | "state_changed" }>
  | Readonly<{ status: "needs_operator_action"; reason: SessionAuthenticationOperatorReason | "identity_conflict" | "restoration_state_conflict" }>
  | Readonly<{ status: "cancelled" }>
  | Readonly<{ status: "invalid_request" }>;

const isNonblank = (value: unknown): value is string => typeof value === "string" && /\S/.test(value);
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isIdentity = (value: unknown): value is SessionAuthenticationAttemptIdentity => isObject(value) && [value.bankCode, value.runId, value.attemptId].every(isNonblank);
const parseAttempt = (value: unknown): SessionAuthenticationAttemptRecord | null => !isObject(value) || !isObject(value.identity) ? null : parseSessionAuthenticationAttemptRecord({ bankCode: value.identity.bankCode, runId: value.identity.runId, attemptId: value.identity.attemptId, status: value.status, interactionPhase: value.interactionPhase, failureClass: value.failureClass, operatorReason: value.operatorReason, retryCount: value.retryCount, ownerToken: value.ownerToken, generation: value.generation, leaseExpiresAt: value.leaseExpiresAt, terminalAt: value.terminalAt, createdAt: value.createdAt, updatedAt: value.updatedAt });
const isAttempt = (value: unknown): value is SessionAuthenticationAttemptRecord => parseAttempt(value) !== null;
const isBound = (owner: { identity: SessionAuthenticationAttemptIdentity; ownerToken: string; generation: bigint }, record: SessionAuthenticationAttemptRecord, identity: SessionAuthenticationAttemptIdentity, ownerToken: string) => owner.generation >= 0n && owner.identity.bankCode === identity.bankCode && owner.identity.runId === identity.runId && owner.identity.attemptId === identity.attemptId && owner.ownerToken === ownerToken && record.status === "active" && record.identity.bankCode === identity.bankCode && record.identity.runId === identity.runId && record.identity.attemptId === identity.attemptId && record.ownerToken === ownerToken && record.generation === owner.generation && record.leaseExpiresAt instanceof Date;
const isExact = (value: unknown): value is Awaited<ReturnType<Attempts["findExact"]>> => isObject(value) && (value.status === "missing" || value.status === "found" && isAttempt(value.record));
const isCreated = (value: unknown): value is Awaited<ReturnType<Attempts["getOrCreate"]>> => isObject(value) && (value.status === "identity_conflict" && typeof value.existingAttemptId === "string" || (value.status === "created" || value.status === "found") && isAttempt(value.record));
const isLeased = (value: unknown): value is Awaited<ReturnType<Attempts["acquireLease"]>> => isObject(value) && (value.status === "missing" || value.status === "not_applied" || ((value.status === "lease_held" || value.status === "reconciliation_required" || value.status === "terminal") && isAttempt(value.record)) || value.status === "lease_acquired" && isObject(value.owner) && isIdentity(value.owner.identity) && typeof value.owner.ownerToken === "string" && typeof value.owner.generation === "bigint" && isAttempt(value.record));
const isReconciled = (value: unknown): value is Awaited<ReturnType<Attempts["reconcileExpiredLease"]>> => isObject(value) && (value.status === "missing" || value.status === "not_applied" || ((value.status === "lease_reconciled" || value.status === "lease_still_active" || value.status === "unowned" || value.status === "terminal") && isAttempt(value.record)));
const isProbe = (value: unknown): value is Awaited<ReturnType<AuthenticatedSessionProbe["observe"]>> => isObject(value) && (value.status === "unauthenticated" || value.status === "unavailable" || value.status === "authenticated" && value.observedAt instanceof Date && !Number.isNaN(value.observedAt.getTime()));
const sameIdentity = (left: SessionAuthenticationAttemptIdentity, right: SessionAuthenticationAttemptIdentity) => left.bankCode === right.bankCode && left.runId === right.runId && left.attemptId === right.attemptId;
const isAuthenticatedCompletion = (value: unknown, owner: { identity: SessionAuthenticationAttemptIdentity; generation: bigint }) => {
  if (!isObject(value) || value.status !== "authenticated") return false;
  const record = parseAttempt(value.record);
  return record?.status === "authenticated" && sameIdentity(record.identity, owner.identity) && record.ownerToken === null && record.leaseExpiresAt === null && record.generation === owner.generation + 1n && record.terminalAt instanceof Date;
};
const isRestorationEvidence = (value: unknown, owner: { identity: SessionAuthenticationAttemptIdentity; generation: bigint }) => isObject(value) && isIdentity(value.identity) && sameIdentity(value.identity, owner.identity) && (value.interactionPhase === "no_credential_interaction" || value.interactionPhase === "credentials_may_have_reached_portal" || value.interactionPhase === "submit_may_have_been_dispatched") && value.terminalGeneration === owner.generation + 1n && value.authenticatedAt instanceof Date && !Number.isNaN(value.authenticatedAt.getTime());
const retryState = (): AuthenticatedSessionState => ({ status: "retry_later", reason: "state_changed" });
const ownershipChanged = (): AuthenticatedSessionState => ({ status: "retry_later", reason: "ownership_changed" });

function terminal(record: SessionAuthenticationAttemptRecord): AuthenticatedSessionState | null {
  if (record.status === "authenticated") return { status: "authenticated", source: "existing" };
  if (record.status === "failed") return { status: "needs_operator_action", reason: record.operatorReason };
  return null;
}

async function findTerminalOrRetry(attempts: Attempts, identity: SessionAuthenticationAttemptIdentity): Promise<AuthenticatedSessionState> {
  let exact: unknown;
  try { exact = await attempts.findExact({ identity }); } catch { return retryState(); }
  if (!isExact(exact)) return retryState();
  return exact.status === "found" ? terminal(exact.record) ?? retryState() : retryState();
}

export async function coordinateAuthenticatedSessionState(
  input: CoordinateAuthenticatedSessionStateInput,
  { attempts, probe, completion }: AuthenticatedSessionCoordinatorDependencies,
): Promise<AuthenticatedSessionState> {
  const { identity, ownerToken, leaseDurationMs, signal } = input;
  if (![identity?.bankCode, identity?.runId, identity?.attemptId, ownerToken].every(isNonblank) || !Number.isSafeInteger(leaseDurationMs) || leaseDurationMs <= 0) return { status: "invalid_request" };
  if (signal?.aborted) return { status: "cancelled" };

  let exact: unknown;
  try { exact = await attempts.findExact({ identity }); } catch { return retryState(); }
  if (!isExact(exact)) return retryState();
  let shouldProbe: boolean;
  if (exact.status === "found") {
    const existing = terminal(exact.record);
    if (existing) return existing;
    shouldProbe = exact.record.ownerToken === null;
  } else {
    let observation: unknown;
    try { observation = await probe.observe({ bankCode: identity.bankCode, signal }); }
    catch { return { status: "retry_later", reason: "session_probe_unavailable" }; }
    if (signal?.aborted) return { status: "cancelled" };
    if (!isProbe(observation)) return { status: "retry_later", reason: "session_probe_unavailable" };
    if (observation.status === "unauthenticated") return acquireAuthenticationMutationAuthority({ identity, ownerToken, leaseDurationMs, signal, repository: attempts, probe });
    if (observation.status === "unavailable") return { status: "retry_later", reason: "session_probe_unavailable" };
    let created: unknown;
    try { created = await attempts.getOrCreate({ identity }); } catch { return retryState(); }
    if (!isCreated(created)) return retryState();
    if (created.status === "identity_conflict") return { status: "needs_operator_action", reason: "identity_conflict" };
    const existing = terminal(created.record);
    if (existing) return existing;
    shouldProbe = false;
  }
  let reconciled = false;
  while (true) {
    if (shouldProbe) {
      let observation: unknown;
      try { observation = await probe.observe({ bankCode: identity.bankCode, signal }); }
      catch { return { status: "retry_later", reason: "session_probe_unavailable" }; }
      if (signal?.aborted) return { status: "cancelled" };
      if (!isProbe(observation)) return { status: "retry_later", reason: "session_probe_unavailable" };
      if (observation.status === "unauthenticated") return acquireAuthenticationMutationAuthority({ identity, ownerToken, leaseDurationMs, signal, repository: attempts, probe });
      if (observation.status === "unavailable") return { status: "retry_later", reason: "session_probe_unavailable" };
    }

    let leased: unknown;
    try { leased = await attempts.acquireLease({ identity, ownerToken, leaseDurationMs }); } catch { return retryState(); }
    if (!isLeased(leased)) return retryState();
    if (leased.status === "lease_held") return { status: "in_progress", reason: "lease_held" };
    if (leased.status === "terminal") return terminal(leased.record) ?? retryState();
    if (leased.status === "missing" || leased.status === "not_applied") return findTerminalOrRetry(attempts, identity);
    if (leased.status === "reconciliation_required") {
      if (reconciled) return retryState();
      reconciled = true;
      let reconciliation: unknown;
      try { reconciliation = await attempts.reconcileExpiredLease({ identity }); } catch { return retryState(); }
      if (!isReconciled(reconciliation)) return retryState();
      if (reconciliation.status === "terminal") return terminal(reconciliation.record) ?? retryState();
      if (reconciliation.status === "lease_still_active") return { status: "in_progress", reason: "lease_held" };
      if (reconciliation.status === "missing" || reconciliation.status === "not_applied") return findTerminalOrRetry(attempts, identity);
      const reconciledTerminal = terminal(reconciliation.record);
      if (reconciledTerminal) return reconciledTerminal;
      shouldProbe = true;
      continue;
    }

    if (!isBound(leased.owner, leased.record, identity, ownerToken)) return ownershipChanged();

    if (completion.mode === "attempt_only") {
      let result: unknown;
      try { result = await attempts.completeAuthenticated({ owner: leased.owner }); } catch { return ownershipChanged(); }
      return isAuthenticatedCompletion(result, leased.owner) ? { status: "authenticated", source: "observed" } : ownershipChanged();
    }
    let restored: unknown;
    try { restored = await completion.resolver.resolveObservedRestoration(leased.owner); } catch { return { status: "needs_operator_action", reason: "restoration_state_conflict" }; }
    if (!isObject(restored) || typeof restored.status !== "string") return { status: "needs_operator_action", reason: "restoration_state_conflict" };
    if ((restored.status === "resolved" || restored.status === "already_resolved") && isRestorationEvidence(restored.evidence, leased.owner)) return { status: "authenticated", source: "observed" };
    if (restored.status === "active_mutation_owner") return { status: "in_progress", reason: "active_mutation_owner" };
    if (restored.status === "stale_owner" || restored.status === "lease_expired" || restored.status === "not_applied") return ownershipChanged();
    return { status: "needs_operator_action", reason: "restoration_state_conflict" };
  }
}
