import {
  coordinateAuthenticatedSessionPrecondition,
  type AuthenticatedSessionMutationRunner,
  type AuthenticatedSessionPreconditionResult,
} from "../modules/bank-sessions/authenticated-session-precondition";
import {
  coordinateAuthenticatedSessionState,
  type AuthenticatedSessionCoordinatorDependencies,
  type CoordinateAuthenticatedSessionStateInput,
} from "../modules/bank-sessions/ensure-authenticated-session";
import type { SessionAuthenticationAttemptIdentity } from "../modules/bank-sessions/session-authentication-attempt";
import {
  createAuthenticatedSessionMutationRunner,
} from "./scraper/authenticated-session-mutation-runner";
import {
  createFixedDelayAuthenticationHeartbeatScheduler,
  resolveAuthenticationHeartbeatConfig,
  type AuthenticationHeartbeatSchedulerDependencies,
} from "./scraper/authentication-heartbeat-scheduler";
import {
  createScrapeTimeAutoLoginAuthenticationExecution,
  type FencedScrapeTimeAutoLoginRunnerDependencies,
} from "./scraper/scrape-time-auto-login-authentication-execution";

type Invocation = Readonly<{ identity: SessionAuthenticationAttemptIdentity; ownerToken: string; signal?: AbortSignal }>;
type AuthenticationJob = Readonly<{ data: Readonly<{ bankId: string; runId: string; accountFingerprint: string }> }>;
type CoordinatorDependencies = Omit<AuthenticatedSessionCoordinatorDependencies, "completion">;
type HeartbeatDependencies = Omit<AuthenticationHeartbeatSchedulerDependencies<unknown>, "delayMs">;

export type AuthenticatedIngestionPreconditionDependencies = Readonly<{
  env: Record<string, string | undefined>;
  coordinatorDependencies: CoordinatorDependencies;
  runnerDependencies: FencedScrapeTimeAutoLoginRunnerDependencies;
  job: unknown;
  heartbeat?: HeartbeatDependencies;
}>;

const review = (): AuthenticatedSessionPreconditionResult => ({ status: "needs_operator_action", reason: "authentication_attempt_requires_review" });
const isNonblank = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return null;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return null;
    result[key] = descriptor.value;
  }
  return result;
}

function parseInvocation(value: unknown): Invocation | null {
  const input = exact(value, ["identity", "ownerToken"]) ?? exact(value, ["identity", "ownerToken", "signal"]);
  if (!input || !isNonblank(input.ownerToken)) return null;
  const identity = exact(input.identity, ["bankCode", "runId", "attemptId"]);
  if (!identity || !isNonblank(identity.bankCode) || !isNonblank(identity.runId) || !isNonblank(identity.attemptId)) return null;
  const signal = parseSignal(input.signal);
  return signal === null ? null : { identity: { bankCode: identity.bankCode, runId: identity.runId, attemptId: identity.attemptId }, ownerToken: input.ownerToken, ...(signal === undefined ? {} : { signal }) };
}

function parseSignal(value: unknown): AbortSignal | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || !AbortSignal.prototype.isPrototypeOf(value)) return null;
  try { void (value as AbortSignal).aborted; return value as AbortSignal; } catch { return null; }
}

function parseJob(value: unknown): AuthenticationJob | null {
  const job = exact(value, ["data"]);
  const data = job && exact(job.data, ["bankId", "runId", "accountFingerprint"]);
  if (!data || !isNonblank(data.bankId) || !isNonblank(data.runId) || !isNonblank(data.accountFingerprint)) return null;
  return { data: { bankId: data.bankId, runId: data.runId, accountFingerprint: data.accountFingerprint } };
}

export function createAuthenticatedIngestionPrecondition(
  dependencies: AuthenticatedIngestionPreconditionDependencies,
): (input: unknown) => Promise<AuthenticatedSessionPreconditionResult> {
  const config = resolveAuthenticationHeartbeatConfig(dependencies.env);
  const job = parseJob(dependencies.job);
  if (!job) throw new Error("Invalid authenticated ingestion precondition configuration.");

  return async (input: unknown): Promise<AuthenticatedSessionPreconditionResult> => {
    try {
      const invocation = parseInvocation(input);
      if (!invocation) return { status: "invalid_request" };
      if (invocation.signal?.aborted) return { status: "cancelled" };
      if (job.data.bankId !== invocation.identity.bankCode || job.data.runId !== invocation.identity.runId) return { status: "invalid_request" };
      const coordinator = { coordinate: (coordinatorInput: CoordinateAuthenticatedSessionStateInput) => coordinateAuthenticatedSessionState(coordinatorInput, { ...dependencies.coordinatorDependencies, completion: { mode: "attempt_only" } }) };
      const runner: AuthenticatedSessionMutationRunner = {
        run: async (authority) => {
          const execution = createScrapeTimeAutoLoginAuthenticationExecution({ runnerDependencies: dependencies.runnerDependencies, job: { data: job.data }, identity: invocation.identity });
          const heartbeat = createFixedDelayAuthenticationHeartbeatScheduler<unknown>({ delayMs: config.heartbeatMs, ...dependencies.heartbeat });
          return createAuthenticatedSessionMutationRunner({ execution, heartbeat }).run(authority);
        },
      };
      const coordinatorInput: CoordinateAuthenticatedSessionStateInput = { identity: invocation.identity, ownerToken: invocation.ownerToken, leaseDurationMs: config.leaseMs, ...(invocation.signal === undefined ? {} : { signal: invocation.signal }) };
      return await coordinateAuthenticatedSessionPrecondition(coordinatorInput, { coordinator, runner });
    } catch {
      return review();
    }
  };
}
