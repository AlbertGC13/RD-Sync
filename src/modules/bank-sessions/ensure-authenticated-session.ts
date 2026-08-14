import type {
  ObservedRestorationResolver,
  SessionAuthenticationAttemptRecord,
  SessionAuthenticationAttemptRepository,
} from "./session-authentication-attempt-repository";
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
const retryState = (): AuthenticatedSessionState => ({ status: "retry_later", reason: "state_changed" });
const ownershipChanged = (): AuthenticatedSessionState => ({ status: "retry_later", reason: "ownership_changed" });

function terminal(record: SessionAuthenticationAttemptRecord): AuthenticatedSessionState | null {
  if (record.status === "authenticated") return { status: "authenticated", source: "existing" };
  if (record.status === "failed") return { status: "needs_operator_action", reason: record.operatorReason };
  return null;
}

async function findTerminalOrRetry(attempts: Attempts, identity: SessionAuthenticationAttemptIdentity): Promise<AuthenticatedSessionState> {
  const exact = await attempts.findExact({ identity });
  return exact.status === "found" ? terminal(exact.record) ?? retryState() : retryState();
}

export async function coordinateAuthenticatedSessionState(
  input: CoordinateAuthenticatedSessionStateInput,
  { attempts, probe, completion }: AuthenticatedSessionCoordinatorDependencies,
): Promise<AuthenticatedSessionState> {
  const { identity, ownerToken, leaseDurationMs, signal } = input;
  if (![identity?.bankCode, identity?.runId, identity?.attemptId, ownerToken].every(isNonblank) || !Number.isSafeInteger(leaseDurationMs) || leaseDurationMs <= 0) return { status: "invalid_request" };
  if (signal?.aborted) return { status: "cancelled" };

  const exact = await attempts.findExact({ identity });
  let shouldProbe: boolean;
  if (exact.status === "found") {
    const existing = terminal(exact.record);
    if (existing) return existing;
    shouldProbe = exact.record.ownerToken === null;
  } else {
    let observation: Awaited<ReturnType<AuthenticatedSessionProbe["observe"]>>;
    try { observation = await probe.observe({ bankCode: identity.bankCode, signal }); }
    catch { return { status: "retry_later", reason: "session_probe_unavailable" }; }
    if (signal?.aborted) return { status: "cancelled" };
    if (observation.status === "unauthenticated") return acquireAuthenticationMutationAuthority({ identity, ownerToken, leaseDurationMs, signal, repository: attempts, probe });
    if (observation.status === "unavailable") return { status: "retry_later", reason: "session_probe_unavailable" };
    const created = await attempts.getOrCreate({ identity });
    if (created.status === "identity_conflict") return { status: "needs_operator_action", reason: "identity_conflict" };
    const existing = terminal(created.record);
    if (existing) return existing;
    shouldProbe = false;
  }
  let reconciled = false;
  while (true) {
    if (shouldProbe) {
      let observation: Awaited<ReturnType<AuthenticatedSessionProbe["observe"]>>;
      try { observation = await probe.observe({ bankCode: identity.bankCode, signal }); }
      catch { return { status: "retry_later", reason: "session_probe_unavailable" }; }
      if (signal?.aborted) return { status: "cancelled" };
      if (observation.status === "unauthenticated") return acquireAuthenticationMutationAuthority({ identity, ownerToken, leaseDurationMs, signal, repository: attempts, probe });
      if (observation.status === "unavailable") return { status: "retry_later", reason: "session_probe_unavailable" };
    }

    const leased = await attempts.acquireLease({ identity, ownerToken, leaseDurationMs });
    if (leased.status === "lease_held") return { status: "in_progress", reason: "lease_held" };
    if (leased.status === "terminal") return terminal(leased.record) ?? retryState();
    if (leased.status === "missing" || leased.status === "not_applied") return findTerminalOrRetry(attempts, identity);
    if (leased.status === "reconciliation_required") {
      if (reconciled) return retryState();
      reconciled = true;
      const reconciliation = await attempts.reconcileExpiredLease({ identity });
      if (reconciliation.status === "terminal") return terminal(reconciliation.record) ?? retryState();
      if (reconciliation.status === "lease_still_active") return { status: "in_progress", reason: "lease_held" };
      if (reconciliation.status === "missing" || reconciliation.status === "not_applied") return findTerminalOrRetry(attempts, identity);
      const reconciledTerminal = terminal(reconciliation.record);
      if (reconciledTerminal) return reconciledTerminal;
      shouldProbe = true;
      continue;
    }

    if (completion.mode === "attempt_only") {
      const result = await attempts.completeAuthenticated({ owner: leased.owner });
      return result.status === "authenticated" ? { status: "authenticated", source: "observed" } : ownershipChanged();
    }
    const restored = await completion.resolver.resolveObservedRestoration(leased.owner);
    if (restored.status === "resolved" || restored.status === "already_resolved") return { status: "authenticated", source: "observed" };
    if (restored.status === "active_mutation_owner") return { status: "in_progress", reason: "active_mutation_owner" };
    if (restored.status === "stale_owner" || restored.status === "lease_expired" || restored.status === "not_applied") return ownershipChanged();
    return { status: "needs_operator_action", reason: "restoration_state_conflict" };
  }
}
