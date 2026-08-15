import type { AuthenticationMutationAuthority } from "./authentication-mutation-authority";
import type {
  AuthenticatedSessionState,
  CoordinateAuthenticatedSessionStateInput,
} from "./ensure-authenticated-session";
import type { SessionAuthenticationOperatorReason } from "./session-authentication-attempt";

export interface AuthenticatedSessionStateCoordinator {
  coordinate(input: CoordinateAuthenticatedSessionStateInput): Promise<AuthenticatedSessionState>;
}

export type AuthenticatedSessionMutationRunnerResult =
  | Readonly<{ status: "authenticated" }>
  | Readonly<{ status: "retry_claimed" }>
  | Readonly<{ status: "retry_exhausted" }>
  | Readonly<{ status: "failed"; reason: SessionAuthenticationOperatorReason }>
  | Readonly<{ status: "unresolved" }>;

export interface AuthenticatedSessionMutationRunner {
  run(authority: AuthenticationMutationAuthority): Promise<AuthenticatedSessionMutationRunnerResult>;
}

export type AuthenticatedSessionPreconditionResult =
  | Readonly<{ status: "authenticated" }>
  | Readonly<{ status: "retry_delivery" }>
  | Readonly<{ status: "needs_operator_action"; reason: SessionAuthenticationOperatorReason | "identity_conflict" | "restoration_state_conflict" }>
  | Readonly<{ status: "in_progress" }>
  | Readonly<{ status: "cancelled" }>
  | Readonly<{ status: "invalid_request" }>;

export type AuthenticatedSessionPreconditionDependencies = Readonly<{
  coordinator: AuthenticatedSessionStateCoordinator;
  runner: AuthenticatedSessionMutationRunner;
}>;

const review = (): AuthenticatedSessionPreconditionResult => ({ status: "needs_operator_action", reason: "authentication_attempt_requires_review" });
const isRecord = (value: unknown): value is Record<PropertyKey, unknown> => typeof value === "object" && value !== null;
const hasOnlyKeys = (value: Record<PropertyKey, unknown>, expected: string[]) => {
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length && keys.every((key) => typeof key === "string" && expected.includes(key));
};
const isOperatorReason = (value: unknown): value is SessionAuthenticationOperatorReason =>
  value === "temporary_authentication_problem"
  || value === "protected_authentication_step_detected"
  || value === "bank_login_configuration_requires_review"
  || value === "authentication_attempt_requires_review";

function mapRunnerResult(value: unknown): AuthenticatedSessionPreconditionResult {
  if (!isRecord(value)) return review();
  if (hasOnlyKeys(value, ["status"]) && value.status === "authenticated") return { status: "authenticated" };
  if (hasOnlyKeys(value, ["status"]) && value.status === "retry_claimed") return { status: "retry_delivery" };
  if (hasOnlyKeys(value, ["status"]) && value.status === "retry_exhausted") return { status: "needs_operator_action", reason: "temporary_authentication_problem" };
  if (hasOnlyKeys(value, ["status"]) && value.status === "unresolved") return review();
  if (hasOnlyKeys(value, ["status", "reason"]) && value.status === "failed" && isOperatorReason(value.reason)) return { status: "needs_operator_action", reason: value.reason };
  return review();
}

export async function coordinateAuthenticatedSessionPrecondition(
  input: CoordinateAuthenticatedSessionStateInput,
  { coordinator, runner }: AuthenticatedSessionPreconditionDependencies,
): Promise<AuthenticatedSessionPreconditionResult> {
  const state = await coordinator.coordinate(input);
  if (state.status === "authenticated") return { status: "authenticated" };
  if (state.status === "retry_later") return { status: "retry_delivery" };
  if (state.status === "in_progress") return { status: "in_progress" };
  if (state.status === "needs_operator_action") return { status: "needs_operator_action", reason: state.reason };
  if (state.status === "cancelled" || state.status === "invalid_request") return state;

  try {
    return mapRunnerResult(await runner.run(state.authority));
  } catch {
    return review();
  }
}
