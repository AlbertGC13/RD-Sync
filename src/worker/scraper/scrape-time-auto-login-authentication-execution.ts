import { createAuthenticationAttemptTrigger } from "../../modules/bank-auto-login-trigger";
import type { SessionAuthenticationAttemptIdentity } from "../../modules/bank-sessions/session-authentication-attempt";
import type { AuthenticationExecution, AuthenticationExecutionResult } from "./authenticated-session-mutation-runner";
import {
  executeScrapeTimeAutoLoginAuthenticationAttempt,
  type ScrapeTimeAutoLoginRunnerDependencies,
  type ScrapeTimeAutoLoginRunnerJob,
} from "./auto-login";

export type FencedScrapeTimeAutoLoginRunnerDependencies = Omit<ScrapeTimeAutoLoginRunnerDependencies, "beforeAutoLoginMutation"> & {
  beforeAutoLoginMutation?: never;
};
type Input = Readonly<{ runnerDependencies: FencedScrapeTimeAutoLoginRunnerDependencies; job: ScrapeTimeAutoLoginRunnerJob; identity: SessionAuthenticationAttemptIdentity }>;
const invalid = (): never => { throw new Error("Invalid authentication execution input"); };
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Reflect.ownKeys(value).length !== keys.length) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string" || !keys.includes(key))) return null;
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return null;
    result[key] = descriptor.value;
  }
  return result;
}

function nonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 256;
}

function jobData(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object") return null;
  const descriptor = Object.getOwnPropertyDescriptor(value, "data");
  return descriptor && descriptor.enumerable && "value" in descriptor ? exact(descriptor.value, ["bankId", "runId", "accountFingerprint"]) : null;
}

function hasLegacyHook(value: object): boolean {
  for (let current: object | null = value; current; current = Object.getPrototypeOf(current)) {
    if (Object.getOwnPropertyDescriptor(current, "beforeAutoLoginMutation")) return true;
  }
  return false;
}

function mapOutcome(value: unknown): AuthenticationExecutionResult {
  const simple = exact(value, ["status"]);
  if (simple?.status === "succeeded") return { status: "succeeded" };
  const summarized = exact(value, ["status", "safeSummary"]);
  if (nonBlankString(summarized?.safeSummary) && summarized?.status === "throttled") return { status: "transient_unavailable" };
  const reasoned = exact(value, ["status", "reason", "safeSummary"]);
  if (!nonBlankString(reasoned?.safeSummary)) return { status: "blocked" };
  if (reasoned?.status === "manual_required" && (reasoned.reason === "lock_busy" || reasoned.reason === "lock_unavailable")) return { status: "transient_unavailable" };
  if (reasoned?.status === "skipped" && (reasoned.reason === "disabled" || reasoned.reason === "breaker_open" || reasoned.reason === "credential_unavailable")) return { status: "rejected", cause: "structural_configuration" };
  if (reasoned?.status !== "needs_admin_action") return { status: "blocked" };
  switch (reasoned.reason) {
    case "protected_flow": return { status: "rejected", cause: "protected_or_mfa" };
    case "incompatible_flow": return { status: "rejected", cause: "incompatible_flow" };
    case "unsupported_bank": case "credential_bank_mismatch": case "missing_required_login_control": case "malformed_url": case "unauthorized_login_page": case "invalid_trigger": case "authentication_trigger_not_ready": return { status: "rejected", cause: "structural_configuration" };
    case "auto_login_config_unavailable": case "credential_unavailable": case "portal_state_unavailable": case "browser_unavailable": case "auto_login_execution_failed": return { status: "transient_unavailable" };
    case "unknown_post_submit_state": return { status: "rejected", cause: "unknown" };
    default: return { status: "blocked" };
  }
}

export function createScrapeTimeAutoLoginAuthenticationExecution(input: Input): AuthenticationExecution {
  const identity = exact(input.identity, ["attemptId", "bankCode", "runId"]);
  const data = jobData(input.job);
  if (hasLegacyHook(input.runnerDependencies) || !identity || !data
    || !nonBlankString(identity.bankCode) || !nonBlankString(identity.runId) || !nonBlankString(identity.attemptId)
    || !nonBlankString(data.bankId) || !nonBlankString(data.runId) || !nonBlankString(data.accountFingerprint)) invalid();
  if (!identity || !data) throw new Error("Invalid authentication execution input");
  let trigger: ReturnType<typeof createAuthenticationAttemptTrigger>;
  try { trigger = createAuthenticationAttemptTrigger(identity as SessionAuthenticationAttemptIdentity); } catch { invalid(); }
  if (data.bankId !== identity.bankCode || data.runId !== identity.runId) invalid();
  const job: ScrapeTimeAutoLoginRunnerJob = { data: { bankId: data.bankId as string, runId: data.runId as string } };
  let used = false;
  return Object.freeze({
    async execute({ fence, signal }: Parameters<AuthenticationExecution["execute"]>[0]): Promise<AuthenticationExecutionResult> {
      if (used) return { status: "blocked" };
      used = true;
      if (signal.aborted) return { status: "cancelled" };
      try {
        const result = await executeScrapeTimeAutoLoginAuthenticationAttempt({ runnerDependencies: input.runnerDependencies, job, trigger: trigger as Extract<typeof trigger, { kind: "authentication_attempt" }>, fence, signal });
        if (result.durableResult?.status === "blocked") return { status: "blocked" };
        if (signal.aborted) return { status: "cancelled" };
        if (result.runnerFailed) return { status: "transient_unavailable" };
        if (result.durableResult?.status === "completed") return mapOutcome(result.durableResult.outcome);
        const outcome = mapOutcome(result.outcome);
        return outcome.status === "succeeded" ? { status: "blocked" } : outcome;
      } catch {
        return signal.aborted ? { status: "cancelled" } : { status: "transient_unavailable" };
      }
    },
  });
}
