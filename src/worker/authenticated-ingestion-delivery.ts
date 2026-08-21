import type { AuthenticatedSessionPreconditionResult } from "../modules/bank-sessions/authenticated-session-precondition";

type DeliveryJob = Readonly<{ data: unknown; signal?: AbortSignal }>;
export type IngestionData = Readonly<{ runId: string; bankId: string; accountFingerprint: string }>;
type Identity = Readonly<{ bankCode: string; runId: string; attemptId: string }>;
type OperatorReason = "temporary_authentication_problem" | "protected_authentication_step_detected" | "bank_login_configuration_requires_review" | "authentication_attempt_requires_review" | "identity_conflict" | "restoration_state_conflict";
type TerminalReason = OperatorReason | "legacy_authenticated_ingestion_delivery" | "invalid_authenticated_ingestion_delivery" | "invalid_authenticated_ingestion_precondition" | "authentication_precondition_requires_review";

export type AuthenticatedIngestionTerminalOutcome = Readonly<{ runId: string; bankId?: string; status: "needs_admin_action" | "failed"; reason: TerminalReason }>;
export type AuthenticatedIngestionAuthenticationInput = Readonly<{ identity: Identity; ownerToken: string; job: Readonly<{ data: IngestionData }>; signal?: AbortSignal }>;
export type AuthenticatedIngestionDeliveryDependencies<TResult> = Readonly<{
  authenticate: (input: AuthenticatedIngestionAuthenticationInput) => Promise<AuthenticatedSessionPreconditionResult>;
  downstream: (job: Readonly<{ data: IngestionData }>) => Promise<TResult>;
  complete: (outcome: AuthenticatedIngestionTerminalOutcome) => Promise<TResult>;
  createOwnerToken: () => string;
}>;

export class AuthenticatedIngestionRetryError extends Error {
  readonly reason: "retry_delivery" | "in_progress" | "cancelled";
  constructor(reason: "retry_delivery" | "in_progress" | "cancelled") { super("Authenticated ingestion delivery must be retried."); this.name = "AuthenticatedIngestionRetryError"; this.reason = reason; }
}
export class AuthenticatedIngestionInvalidJobError extends Error { constructor() { super("Invalid authenticated ingestion delivery job."); this.name = "AuthenticatedIngestionInvalidJobError"; } }
export class AuthenticatedIngestionTerminalError extends Error { constructor() { super("Authenticated ingestion terminal completion failed."); this.name = "AuthenticatedIngestionTerminalError"; } }

const isNonblank = (value: unknown): value is string => typeof value === "string" && /\S/.test(value);
const operatorReasons: readonly OperatorReason[] = ["temporary_authentication_problem", "protected_authentication_step_detected", "bank_login_configuration_requires_review", "authentication_attempt_requires_review", "identity_conflict", "restoration_state_conflict"];
const readNativeAbortSignal = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return null;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const record: Record<string, unknown> = {};
  for (const key of keys) { const descriptor = descriptors[key]; if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return null; record[key] = descriptor.value; }
  return record;
}

function safeRunId(value: unknown): string | null {
  try {
    if (value === null || typeof value !== "object") return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, "runId");
    return descriptor?.enumerable && "value" in descriptor && isNonblank(descriptor.value) ? descriptor.value : null;
  } catch { return null; }
}

function signal(value: unknown): AbortSignal | null | undefined {
  if (value === undefined) return undefined;
  try { return value !== null && typeof value === "object" && readNativeAbortSignal?.call(value) !== undefined ? value as AbortSignal : null; } catch { return null; }
}

function aborted(value: AbortSignal): boolean | null {
  try { return readNativeAbortSignal?.call(value) ?? null; } catch { return null; }
}

function parseData(value: unknown): Readonly<{ kind: "v1"; data: IngestionData; identity: Identity }> | Readonly<{ kind: "legacy"; data: IngestionData }> | null {
  const v1 = exact(value, ["runId", "bankId", "accountFingerprint", "authentication"]);
  if (v1) {
    const authentication = exact(v1.authentication, ["version", "attemptId"]);
    if (authentication && authentication.version === 1 && isNonblank(v1.runId) && isNonblank(v1.bankId) && isNonblank(v1.accountFingerprint) && isNonblank(authentication.attemptId)) return { kind: "v1", data: { runId: v1.runId, bankId: v1.bankId, accountFingerprint: v1.accountFingerprint }, identity: { bankCode: v1.bankId, runId: v1.runId, attemptId: authentication.attemptId } };
  }
  const legacy = exact(value, ["runId", "bankId", "accountFingerprint"]) ?? exact(value, ["runId", "bankId", "accountFingerprint", "expiredEventId"]);
  if (legacy && isNonblank(legacy.runId) && isNonblank(legacy.bankId) && isNonblank(legacy.accountFingerprint) && (legacy.expiredEventId === undefined || isNonblank(legacy.expiredEventId))) return { kind: "legacy", data: { runId: legacy.runId, bankId: legacy.bankId, accountFingerprint: legacy.accountFingerprint } };
  return null;
}

function preconditionDecision(value: unknown): "authenticated" | "retry_delivery" | "in_progress" | "cancelled" | OperatorReason | "invalid_authenticated_ingestion_precondition" | "authentication_precondition_requires_review" {
  const status = exact(value, ["status"]);
  if (status && (status.status === "authenticated" || status.status === "retry_delivery" || status.status === "in_progress" || status.status === "cancelled" || status.status === "invalid_request")) return status.status === "invalid_request" ? "invalid_authenticated_ingestion_precondition" : status.status;
  const operator = exact(value, ["status", "reason"]);
  return operator?.status === "needs_operator_action" && typeof operator.reason === "string" && operatorReasons.includes(operator.reason as OperatorReason) ? operator.reason as OperatorReason : "authentication_precondition_requires_review";
}

export function createAuthenticatedIngestionDeliveryProcessor<TResult>(dependencies: AuthenticatedIngestionDeliveryDependencies<TResult>): (job: DeliveryJob) => Promise<TResult> {
  const complete = async (outcome: AuthenticatedIngestionTerminalOutcome): Promise<TResult> => { try { return await dependencies.complete(outcome); } catch { throw new AuthenticatedIngestionTerminalError(); } };
  return async (job: DeliveryJob): Promise<TResult> => {
    let data: unknown; let jobSignal: AbortSignal | null | undefined;
    try { const envelope = exact(job, ["data"]) ?? exact(job, ["data", "signal"]); data = envelope?.data; jobSignal = signal(envelope?.signal); } catch { data = undefined; jobSignal = null; }
    const parsed = (() => { try { return parseData(data); } catch { return null; } })();
    if (!parsed) {
      const runId = safeRunId(data);
      if (!runId) throw new AuthenticatedIngestionInvalidJobError();
      return complete({ runId, status: "failed", reason: "invalid_authenticated_ingestion_delivery" });
    }
    if (parsed.kind === "legacy") return complete({ runId: parsed.data.runId, bankId: parsed.data.bankId, status: "needs_admin_action", reason: "legacy_authenticated_ingestion_delivery" });
    if (jobSignal === null) return complete({ runId: parsed.data.runId, bankId: parsed.data.bankId, status: "failed", reason: "invalid_authenticated_ingestion_delivery" });
    let decision: ReturnType<typeof preconditionDecision>;
    try {
      const ownerToken = dependencies.createOwnerToken();
      decision = isNonblank(ownerToken) ? preconditionDecision(await dependencies.authenticate({ identity: parsed.identity, ownerToken, job: { data: parsed.data }, ...(jobSignal === undefined ? {} : { signal: jobSignal }) })) : "authentication_precondition_requires_review";
    } catch { decision = "authentication_precondition_requires_review"; }
    if (decision === "authenticated") {
      if (jobSignal !== undefined && aborted(jobSignal) !== false) throw new AuthenticatedIngestionRetryError("cancelled");
      return dependencies.downstream({ data: parsed.data });
    }
    if (decision === "retry_delivery" || decision === "in_progress" || decision === "cancelled") throw new AuthenticatedIngestionRetryError(decision);
    return complete({ runId: parsed.data.runId, bankId: parsed.data.bankId, status: decision === "invalid_authenticated_ingestion_precondition" ? "failed" : "needs_admin_action", reason: decision });
  };
}
