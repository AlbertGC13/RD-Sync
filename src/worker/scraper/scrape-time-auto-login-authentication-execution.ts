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
const invalid = () => { throw new Error("Invalid authentication execution input"); };
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Reflect.ownKeys(value).length !== keys.length) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string" || !keys.includes(key))) return null;
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor)) return null;
    result[key] = descriptor.value;
  }
  return result;
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
  if (summarized?.status === "throttled" || summarized?.status === "manual_required") return { status: "transient_unavailable" };
  const reasoned = exact(value, ["status", "reason", "safeSummary"]);
  if (reasoned?.status === "skipped") return { status: "rejected", cause: "structural_configuration" };
  if (reasoned?.status !== "needs_admin_action") return { status: "blocked" };
  switch (reasoned.reason) {
    case "protected_flow": return { status: "rejected", cause: "protected_or_mfa" };
    case "incompatible_flow": return { status: "rejected", cause: "incompatible_flow" };
    case "unsupported_bank": case "credential_bank_mismatch": case "missing_required_login_control": case "malformed_url": case "unauthorized_login_page": return { status: "rejected", cause: "structural_configuration" };
    case "auto_login_config_unavailable": case "credential_unavailable": case "portal_state_unavailable": case "browser_unavailable": return { status: "transient_unavailable" };
    case "unknown_post_submit_state": return { status: "rejected", cause: "unknown" };
    default: return { status: "blocked" };
  }
}

export function createScrapeTimeAutoLoginAuthenticationExecution(input: Input): AuthenticationExecution {
  if (hasLegacyHook(input.runnerDependencies) || !exact(input.identity, ["attemptId", "bankCode", "runId"])) invalid();
  let trigger: ReturnType<typeof createAuthenticationAttemptTrigger>;
  try { trigger = createAuthenticationAttemptTrigger(input.identity); } catch { invalid(); }
  const data = input.job.data;
  if (data.bankId !== input.identity.bankCode || data.runId !== input.identity.runId || Object.hasOwn(data, "expiredEventId")) invalid();
  const job: ScrapeTimeAutoLoginRunnerJob = { data: { bankId: data.bankId, runId: data.runId } };
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
        if (result.durableResult?.status === "completed") return mapOutcome(result.durableResult.outcome);
        const outcome = mapOutcome(result.outcome);
        return outcome.status === "succeeded" ? { status: "blocked" } : outcome;
      } catch {
        return signal.aborted ? { status: "cancelled" } : { status: "transient_unavailable" };
      }
    },
  });
}
