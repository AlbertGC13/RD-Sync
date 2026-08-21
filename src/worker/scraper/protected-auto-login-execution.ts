import { assertCdpLoopback } from "./browser-runtime";
import type { BankAutoLoginAdminActionReason, BankAutoLoginOutcome, BankAutoLoginPage, BankAutoLoginStrategy } from "./auto-login";
import { executeDurablyFencedAutoLogin } from "./durable-auto-login-mutation";
import { isCredentialMutationFence, type CredentialMutationFence } from "./authenticated-session-mutation-runner";
import { isStrictAutoLoginCredential, type StrictAutoLoginCredential } from "./strict-auto-login-credential-loader";

type Result = Readonly<{ status: "completed"; outcome: BankAutoLoginOutcome }> | Readonly<{ status: "blocked" | "throttled" | "browser_unavailable" | "structural_configuration" }>;
type ReadyBrowser = Readonly<{ status: "ready"; page: BankAutoLoginPage; close(): Promise<void> }>;
type Input = Readonly<{ job: unknown; identity: unknown; credential: StrictAutoLoginCredential; fence: CredentialMutationFence; signal: AbortSignal; cdpUrl: string; adapter: unknown; ensureBrowser: unknown }>;
const abortState = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;
const reasons: readonly BankAutoLoginAdminActionReason[] = ["unsupported_bank", "credential_bank_mismatch", "auto_login_config_unavailable", "credential_unavailable", "incompatible_flow", "protected_flow", "missing_required_login_control", "portal_state_unavailable", "malformed_url", "unauthorized_login_page", "unknown_post_submit_state", "browser_unavailable", "invalid_trigger", "authentication_trigger_not_ready", "auto_login_execution_failed"];
const blocked = (): Result => Object.freeze({ status: "blocked" });
const fixed = (status: Exclude<Result["status"], "completed" | "blocked">): Result => Object.freeze({ status });

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return null;
    const own = Reflect.ownKeys(value); const descriptors = Object.getOwnPropertyDescriptors(value);
    if (own.length !== keys.length || own.some((key) => typeof key !== "string" || !keys.includes(key))) return null;
    const parsed: Record<string, unknown> = {};
    for (const key of keys) { const descriptor = descriptors[key]; if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return null; parsed[key] = descriptor.value; }
    return parsed;
  } catch { return null; }
}
const nonblank = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 256;
const signalState = (signal: unknown): boolean | null => { try { return signal !== null && typeof signal === "object" && abortState ? abortState.call(signal) : null; } catch { return null; } };

function validInput(input: Input): boolean {
  const job = exact(input.job, ["bankCode", "runId", "accountFingerprint"]); const identity = exact(input.identity, ["bankCode", "runId", "attemptId"]); const credential = input.credential;
  if (!job || !identity || !credential || ![job.bankCode, job.runId, job.accountFingerprint, identity.bankCode, identity.runId, identity.attemptId, credential.bankCode, credential.username, credential.password].every(nonblank)) return false;
  if (!Object.isFrozen(input.job) || !Object.isFrozen(input.identity) || !isStrictAutoLoginCredential(credential) || job.bankCode !== identity.bankCode || job.runId !== identity.runId || credential.bankCode !== job.bankCode) return false;
  return isCredentialMutationFence(input.fence) && signalState(input.signal) === false;
}

function configuration(input: Input): boolean {
  if (typeof input.cdpUrl !== "string" || typeof input.ensureBrowser !== "function") return false;
  const job = exact(input.job, ["bankCode", "runId", "accountFingerprint"]);
  const adapter = exact(input.adapter, ["bankCode", "createAutoLoginStrategy"]);
  try { assertCdpLoopback(input.cdpUrl); } catch { return false; }
  return !!job && !!adapter && Object.isFrozen(input.adapter) && adapter.bankCode === job.bankCode && typeof adapter.createAutoLoginStrategy === "function";
}

function safeOutcome(value: unknown): BankAutoLoginOutcome | null {
  const succeeded = exact(value, ["status"]);
  if (succeeded?.status === "succeeded") return Object.freeze({ status: "succeeded" });
  const action = exact(value, ["status", "reason", "safeSummary"]);
  if (action?.status !== "needs_admin_action" || !reasons.includes(action.reason as BankAutoLoginAdminActionReason) || typeof action.safeSummary !== "string") return null;
  return Object.freeze({ status: "needs_admin_action", reason: action.reason as BankAutoLoginAdminActionReason, safeSummary: "Bank authentication requires administrator action." });
}

function ready(value: unknown): ReadyBrowser | null {
  const parsed = exact(value, ["status", "page", "close"]);
  if (parsed?.status !== "ready" || parsed.page === null || typeof parsed.page !== "object" || typeof parsed.close !== "function") return null;
  try { return ["currentUrl", "hasVisibleSelector", "fill", "click"].every((key) => typeof (parsed.page as Record<string, unknown>)[key] === "function") && typeof (parsed.page as Record<string, unknown>).protectedStateDetectionWindowMs === "number" ? value as ReadyBrowser : null; } catch { return null; }
}

function durable(value: unknown): Readonly<{ status: "blocked" }> | Readonly<{ status: "completed"; outcome: unknown }> | null {
  const blockedResult = exact(value, ["status"]); if (blockedResult?.status === "blocked") return { status: "blocked" };
  const completed = exact(value, ["status", "outcome"]); return completed?.status === "completed" ? { status: "completed", outcome: completed.outcome } : null;
}

export function createProtectedAutoLoginExecution(input: unknown): Readonly<{ execute(): Promise<Result> }> {
  return Object.freeze({ async execute(): Promise<Result> {
    let opened: ReadyBrowser | null = null;
    try {
      const candidate = exact(input, ["job", "identity", "credential", "fence", "signal", "cdpUrl", "adapter", "ensureBrowser"]);
      if (!candidate || !Object.isFrozen(input)) return blocked();
      const parsed = candidate as Input;
      if (!validInput(parsed)) return blocked();
      if (!configuration(parsed)) return fixed("structural_configuration");
      let browserResult: unknown;
      try { browserResult = await (parsed.ensureBrowser as (bankCode: string, cdpUrl: string) => Promise<unknown>)((parsed.job as { bankCode: string }).bankCode, parsed.cdpUrl); } catch { return fixed("browser_unavailable"); }
      if (exact(browserResult, ["status"])?.status === "throttled") return fixed("throttled");
      opened = ready(browserResult); if (!opened) return fixed("browser_unavailable");
      let strategy: BankAutoLoginStrategy;
      try { strategy = (parsed.adapter as { createAutoLoginStrategy(): BankAutoLoginStrategy }).createAutoLoginStrategy(); } catch { return fixed("structural_configuration"); }
      if (!exact(strategy, ["bankCode", "autoLogin"]) || strategy.bankCode !== (parsed.job as { bankCode: string }).bankCode || typeof strategy.autoLogin !== "function") return fixed("structural_configuration");
      const durableResult = durable(await executeDurablyFencedAutoLogin({ strategy, credential: parsed.credential, page: opened.page, fence: parsed.fence, signal: parsed.signal }));
      if (!durableResult || durableResult.status !== "completed") return blocked();
      const outcome = safeOutcome(durableResult.outcome);
      return outcome ? Object.freeze({ status: "completed", outcome }) : blocked();
    } catch { return blocked(); }
    finally { if (opened) try { await opened.close(); } catch { /* Browser cleanup never changes the safe execution result. */ } }
  } });
}
