import {
  coordinateAuthenticatedSessionPrecondition,
  type AuthenticatedSessionMutationRunner,
  type AuthenticatedSessionPreconditionResult,
  type AuthenticatedSessionStateCoordinator,
} from "../modules/bank-sessions/authenticated-session-precondition";
import {
  coordinateAuthenticatedSessionState,
  type AuthenticatedSessionCoordinatorDependencies,
  type CoordinateAuthenticatedSessionStateInput,
} from "../modules/bank-sessions/ensure-authenticated-session";
import type { SessionAuthenticationAttemptIdentity } from "../modules/bank-sessions/session-authentication-attempt";
import {
  createAuthenticatedSessionMutationRunner,
  type AuthenticationExecution,
  type AuthenticationHeartbeatScheduler,
} from "./scraper/authenticated-session-mutation-runner";
import {
  createFixedDelayAuthenticationHeartbeatScheduler,
  resolveAuthenticationHeartbeatConfig,
} from "./scraper/authentication-heartbeat-scheduler";
import {
  createScrapeTimeAutoLoginAuthenticationExecution,
  type FencedScrapeTimeAutoLoginRunnerDependencies,
} from "./scraper/scrape-time-auto-login-authentication-execution";
import type { ScrapeTimeAutoLoginRunnerJob } from "./scraper/auto-login";

type Invocation = Readonly<{ identity: SessionAuthenticationAttemptIdentity; ownerToken: string; signal?: AbortSignal }>;
type AuthenticationJob = Readonly<{ data: Readonly<{ bankId: string; runId: string; accountFingerprint: string }> }>;
type CoordinatorDependencies = Omit<AuthenticatedSessionCoordinatorDependencies, "completion">;
type ExecutionFactory = (input: Readonly<{ runnerDependencies: FencedScrapeTimeAutoLoginRunnerDependencies; job: ScrapeTimeAutoLoginRunnerJob; identity: SessionAuthenticationAttemptIdentity }>) => AuthenticationExecution;
type RunnerFactory = (dependencies: Readonly<{ execution: AuthenticationExecution; heartbeat: AuthenticationHeartbeatScheduler }>) => AuthenticatedSessionMutationRunner;
type HeartbeatFactory = (dependencies: Readonly<{ delayMs: number }>) => AuthenticationHeartbeatScheduler;

export type AuthenticatedIngestionPreconditionDependencies = Readonly<{
  env: Record<string, string | undefined>;
  coordinatorDependencies: CoordinatorDependencies;
  runnerDependencies: FencedScrapeTimeAutoLoginRunnerDependencies;
  job: unknown;
  createCoordinator?: (dependencies: AuthenticatedSessionCoordinatorDependencies) => AuthenticatedSessionStateCoordinator;
  createExecution?: ExecutionFactory;
  createRunner?: RunnerFactory;
  createHeartbeat?: HeartbeatFactory;
}>;

const review = (): AuthenticatedSessionPreconditionResult => ({ status: "needs_operator_action", reason: "authentication_attempt_requires_review" });
const isNonblank = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 256;

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
  if (!input || !isNonblank(input.ownerToken) || (input.signal !== undefined && (input.signal === null || typeof input.signal !== "object"))) return null;
  const identity = exact(input.identity, ["bankCode", "runId", "attemptId"]);
  if (!identity || !isNonblank(identity.bankCode) || !isNonblank(identity.runId) || !isNonblank(identity.attemptId)) return null;
  return { identity: { bankCode: identity.bankCode, runId: identity.runId, attemptId: identity.attemptId }, ownerToken: input.ownerToken, ...(input.signal === undefined ? {} : { signal: input.signal as AbortSignal }) };
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
  const createCoordinator = dependencies.createCoordinator ?? ((coordinatorDependencies) => ({ coordinate: (input) => coordinateAuthenticatedSessionState(input, coordinatorDependencies) }));
  const createExecution = dependencies.createExecution ?? createScrapeTimeAutoLoginAuthenticationExecution;
  const createRunner = dependencies.createRunner ?? createAuthenticatedSessionMutationRunner;
  const createHeartbeat = dependencies.createHeartbeat ?? createFixedDelayAuthenticationHeartbeatScheduler;

  return async (input: unknown): Promise<AuthenticatedSessionPreconditionResult> => {
    const invocation = parseInvocation(input);
    if (!invocation) return { status: "invalid_request" };
    if (invocation.signal?.aborted) return { status: "cancelled" };
    if (job.data.bankId !== invocation.identity.bankCode || job.data.runId !== invocation.identity.runId) return { status: "invalid_request" };
    try {
      const coordinator = createCoordinator({ ...dependencies.coordinatorDependencies, completion: { mode: "attempt_only" } });
      const runner: AuthenticatedSessionMutationRunner = {
        run: async (authority) => {
          const execution = createExecution({ runnerDependencies: dependencies.runnerDependencies, job: { data: job.data }, identity: invocation.identity });
          return createRunner({ execution, heartbeat: createHeartbeat({ delayMs: config.heartbeatMs }) }).run(authority);
        },
      };
      const coordinatorInput: CoordinateAuthenticatedSessionStateInput = { identity: invocation.identity, ownerToken: invocation.ownerToken, leaseDurationMs: config.leaseMs, ...(invocation.signal === undefined ? {} : { signal: invocation.signal }) };
      return await coordinateAuthenticatedSessionPrecondition(coordinatorInput, { coordinator, runner });
    } catch {
      return review();
    }
  };
}
