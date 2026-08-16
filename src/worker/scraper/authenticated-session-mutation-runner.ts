import { claimAuthenticationMutationAuthority } from "../../modules/bank-sessions/authentication-mutation-authority";
import type { AuthenticationMutationAuthority } from "../../modules/bank-sessions/authentication-mutation-authority";
import type { AuthenticatedSessionMutationRunner, AuthenticatedSessionMutationRunnerResult } from "../../modules/bank-sessions/authenticated-session-precondition";
import type { SessionAuthenticationFailurePair } from "../../modules/bank-sessions/session-authentication-attempt-repository";

export type AuthenticationExecutionResult = Readonly<{ status: "succeeded" | "transient_unavailable" | "cancelled" | "blocked" }> | Readonly<{ status: "rejected"; cause: "protected_or_mfa" | "incompatible_flow" | "structural_configuration" | "unknown" }>;
export interface CredentialMutationFence { beginCredentialInteraction(): Promise<Readonly<{ status: "authorized" | "blocked" }>>; renewBeforeCredentialMutation(): Promise<Readonly<{ status: "authorized" | "blocked" }>>; recordSubmitBarrier(): Promise<Readonly<{ status: "authorized" | "blocked" }>>; }
export interface AuthenticationExecution { execute(input: Readonly<{ fence: CredentialMutationFence; signal: AbortSignal }>): Promise<AuthenticationExecutionResult>; }
export interface AuthenticationHeartbeatScheduler { start(heartbeat: () => Promise<void>): Readonly<{ stop(): Promise<void> }>; }
export type AuthenticatedSessionMutationRunnerDependencies = Readonly<{ execution: AuthenticationExecution; heartbeat: AuthenticationHeartbeatScheduler }>;

type Phase = "leased" | "interaction_started" | "submit_barrier_recorded";
type Decision = Readonly<{ kind: "authenticated" }> | Readonly<{ kind: "retry" }> | Readonly<{ kind: "failed"; failure: SessionAuthenticationFailurePair }>;
const isRecord = (value: unknown): value is Record<PropertyKey, unknown> => typeof value === "object" && value !== null;
const exact = (value: unknown, keys: readonly string[]) => isRecord(value) && Reflect.ownKeys(value).length === keys.length && Reflect.ownKeys(value).every((key) => typeof key === "string" && keys.includes(key));
const executionResult = (value: unknown): AuthenticationExecutionResult | null => {
  const record = value as Record<PropertyKey, unknown>;
  if (exact(value, ["status"]) && (record.status === "succeeded" || record.status === "transient_unavailable" || record.status === "cancelled" || record.status === "blocked")) return value as AuthenticationExecutionResult;
  if (exact(value, ["status", "cause"]) && record.status === "rejected" && (record.cause === "protected_or_mfa" || record.cause === "incompatible_flow" || record.cause === "structural_configuration" || record.cause === "unknown")) return value as AuthenticationExecutionResult;
  return null;
};
const uncertain = (): SessionAuthenticationFailurePair => ({ failureClass: "interaction_outcome_uncertain", operatorReason: "authentication_attempt_requires_review" });
const unclassified = (): SessionAuthenticationFailurePair => ({ failureClass: "unclassified_failure", operatorReason: "authentication_attempt_requires_review" });
const failure = (phase: Phase) => phase === "leased" ? unclassified() : uncertain();
const decide = (result: AuthenticationExecutionResult | null, phase: Phase): Decision => {
  if (result?.status === "succeeded" && phase === "submit_barrier_recorded") return { kind: "authenticated" };
  if ((result?.status === "transient_unavailable" || result?.status === "cancelled") && phase === "leased") return { kind: "retry" };
  if (result?.status === "rejected") {
    if (result.cause === "protected_or_mfa") return { kind: "failed", failure: { failureClass: "protected_or_mfa", operatorReason: "protected_authentication_step_detected" } };
    if (result.cause === "incompatible_flow" || result.cause === "structural_configuration") return { kind: "failed", failure: { failureClass: result.cause, operatorReason: "bank_login_configuration_requires_review" } };
  }
  return { kind: "failed", failure: failure(phase) };
};
class Gate { private tail = Promise.resolve(); run<T>(work: () => Promise<T>): Promise<T> { const next = this.tail.then(work, work); this.tail = next.then(() => undefined, () => undefined); return next; } async drain() { await this.tail; } }

export function createAuthenticatedSessionMutationRunner({ execution, heartbeat }: AuthenticatedSessionMutationRunnerDependencies): AuthenticatedSessionMutationRunner {
  return {
    async run(authority: AuthenticationMutationAuthority): Promise<AuthenticatedSessionMutationRunnerResult> {
      const claimed = claimAuthenticationMutationAuthority(authority);
      if (claimed.status !== "claimed") return { status: "unresolved" };
      const gate = new Gate(); const controller = new AbortController(); let phase: Phase = "leased"; let sticky = false;
      const fail = () => { if (!sticky) { sticky = true; controller.abort(); } };
      const guarded = (operation: () => Promise<unknown>, advance?: Phase) => gate.run(async () => {
        if (sticky) return { status: "blocked" } as const;
        try { const result = await operation(); if (!exact(result, ["status"]) || (result as Record<PropertyKey, unknown>).status !== "authorized") { fail(); return { status: "blocked" } as const; } if (advance) phase = advance; return { status: "authorized" } as const; }
        catch { fail(); return { status: "blocked" } as const; }
      });
      const fence: CredentialMutationFence = { beginCredentialInteraction: () => guarded(() => claimed.authority.beginCredentialInteraction(), "interaction_started"), renewBeforeCredentialMutation: () => guarded(() => claimed.authority.renewLease()), recordSubmitBarrier: () => guarded(() => claimed.authority.recordSubmitBarrier(), "submit_barrier_recorded") };
      let scheduler: Readonly<{ stop(): Promise<void> }>; let stopped = false;
      try { scheduler = heartbeat.start(() => stopped ? Promise.resolve() : guarded(() => claimed.authority.renewLease()).then(() => undefined)); } catch { return { status: "unresolved" }; }
      let result: unknown = null;
      try { result = await execution.execute({ fence, signal: controller.signal }); } catch { result = null; }
      stopped = true;
      try { await scheduler.stop(); } catch { fail(); }
      await gate.drain();
      if (sticky) return { status: "unresolved" };
      const decision = decide(executionResult(result), phase);
      return gate.run(async () => {
        if (sticky) return { status: "unresolved" };
        try {
          if (decision.kind === "retry") { const retry = await claimed.authority.claimRetry(); return exact(retry, ["status"]) && (retry.status === "retry_claimed" || retry.status === "retry_exhausted") ? { status: retry.status } : { status: "unresolved" }; }
          if (decision.kind === "authenticated") { const completed = await claimed.authority.completeAuthenticated(); return exact(completed, ["status"]) && completed.status === "completed" ? { status: "authenticated" } : { status: "unresolved" }; }
          const completed = await claimed.authority.completeFailed(decision.failure); return exact(completed, ["status"]) && completed.status === "completed" ? { status: "failed", reason: decision.failure.operatorReason } : { status: "unresolved" };
        } catch { return { status: "unresolved" }; }
      });
    },
  };
}
