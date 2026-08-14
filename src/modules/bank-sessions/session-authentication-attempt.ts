export type SessionAuthenticationAttemptIdentity = Readonly<{
  bankCode: string;
  runId: string;
  attemptId: string;
}>;

export type CredentialInteractionPhase =
  | "no_credential_interaction"
  | "credentials_may_have_reached_portal"
  | "submit_may_have_been_dispatched";

export type SessionAuthenticationFailureCause =
  | "transient_infrastructure"
  | "protected_or_mfa_detected"
  | "incompatible_flow_detected"
  | "structural_configuration_error"
  | "ownership_lost"
  | "unknown_failure";

export type SessionAuthenticationFailureClass =
  | "transient_pre_interaction"
  | "protected_or_mfa"
  | "incompatible_flow"
  | "structural_configuration"
  | "ownership_lost"
  | "interaction_outcome_uncertain"
  | "unclassified_failure";

export type SessionAuthenticationOperatorReason =
  | "temporary_authentication_problem"
  | "protected_authentication_step_detected"
  | "bank_login_configuration_requires_review"
  | "authentication_attempt_requires_review";

export type SessionAuthenticationAttempt =
  | Readonly<{
      status: "active";
      identity: SessionAuthenticationAttemptIdentity;
      interactionPhase: CredentialInteractionPhase;
    }>
  | Readonly<{
      status: "authenticated";
      identity: SessionAuthenticationAttemptIdentity;
      interactionPhase: CredentialInteractionPhase;
    }>
  | Readonly<{
      status: "failed";
      identity: SessionAuthenticationAttemptIdentity;
      interactionPhase: CredentialInteractionPhase;
      failureClass: SessionAuthenticationFailureClass;
      operatorReason: SessionAuthenticationOperatorReason;
    }>;

export type SessionAuthenticationEvent =
  | Readonly<{ type: "begin_credential_interaction" }>
  | Readonly<{ type: "record_submit_barrier" }>
  | Readonly<{ type: "confirm_authenticated" }>
  | Readonly<{ type: "fail"; cause: SessionAuthenticationFailureCause }>;

export type SessionAuthenticationRetryDisposition =
  | "retry_automatically"
  | "do_not_retry";

export const MAX_SESSION_AUTHENTICATION_RETRIES = 2 as const;

export type SessionAuthenticationRetryBudget = Readonly<{
  retriesConsumed: number;
  maxAdditionalRetries: typeof MAX_SESSION_AUTHENTICATION_RETRIES;
}>;

const INVALID_TRANSITION_ERROR = "Invalid session authentication attempt transition";

export function createSessionAuthenticationAttempt(
  identity: SessionAuthenticationAttemptIdentity,
): Extract<SessionAuthenticationAttempt, { status: "active" }> {
  return {
    status: "active",
    identity,
    interactionPhase: "no_credential_interaction",
  };
}

export function transitionSessionAuthenticationAttempt(
  attempt: SessionAuthenticationAttempt,
  event: SessionAuthenticationEvent,
): SessionAuthenticationAttempt {
  if (attempt.status !== "active") throw new Error(INVALID_TRANSITION_ERROR);

  switch (event.type) {
    case "begin_credential_interaction":
      if (attempt.interactionPhase !== "no_credential_interaction") throw new Error(INVALID_TRANSITION_ERROR);
      return { ...attempt, interactionPhase: "credentials_may_have_reached_portal" };
    case "record_submit_barrier":
      if (attempt.interactionPhase !== "credentials_may_have_reached_portal") throw new Error(INVALID_TRANSITION_ERROR);
      return { ...attempt, interactionPhase: "submit_may_have_been_dispatched" };
    case "confirm_authenticated":
      return {
        status: "authenticated",
        identity: attempt.identity,
        interactionPhase: attempt.interactionPhase,
      };
    case "fail": {
      const classification = classifySessionAuthenticationFailure(attempt.interactionPhase, event.cause);
      return {
        status: "failed",
        identity: attempt.identity,
        interactionPhase: attempt.interactionPhase,
        ...classification,
      };
    }
  }
}

export function classifySessionAuthenticationFailure(
  interactionPhase: CredentialInteractionPhase,
  cause: SessionAuthenticationFailureCause,
): Readonly<{
  failureClass: SessionAuthenticationFailureClass;
  operatorReason: SessionAuthenticationOperatorReason;
}> {
  if (cause === "transient_infrastructure") {
    return interactionPhase === "no_credential_interaction"
      ? { failureClass: "transient_pre_interaction", operatorReason: "temporary_authentication_problem" }
      : { failureClass: "interaction_outcome_uncertain", operatorReason: "authentication_attempt_requires_review" };
  }

  switch (cause) {
    case "protected_or_mfa_detected":
      return { failureClass: "protected_or_mfa", operatorReason: "protected_authentication_step_detected" };
    case "incompatible_flow_detected":
      return { failureClass: "incompatible_flow", operatorReason: "bank_login_configuration_requires_review" };
    case "structural_configuration_error":
      return { failureClass: "structural_configuration", operatorReason: "bank_login_configuration_requires_review" };
    case "ownership_lost":
      return { failureClass: "ownership_lost", operatorReason: "authentication_attempt_requires_review" };
    case "unknown_failure":
      return { failureClass: "unclassified_failure", operatorReason: "authentication_attempt_requires_review" };
  }
}

/**
 * Automatic retry is bounded to two slots, which callers must durably claim.
 * After credential interaction begins, portal-observable events or partial
 * mutation make even transient failures non-retryable; this never authorizes
 * an unbounded retry loop.
 */
export function deriveSessionAuthenticationRetryDisposition(
  attempt: Exclude<SessionAuthenticationAttempt, { status: "active" }>,
  budget: SessionAuthenticationRetryBudget,
): SessionAuthenticationRetryDisposition {
  return isValidSessionAuthenticationRetryBudget(budget)
    && attempt.status === "failed"
    && attempt.interactionPhase === "no_credential_interaction"
    && attempt.failureClass === "transient_pre_interaction"
    && budget.retriesConsumed < budget.maxAdditionalRetries
    ? "retry_automatically"
    : "do_not_retry";
}

function isValidSessionAuthenticationRetryBudget(budget: SessionAuthenticationRetryBudget): boolean {
  return Number.isInteger(budget.retriesConsumed)
    && budget.retriesConsumed >= 0
    && budget.maxAdditionalRetries === MAX_SESSION_AUTHENTICATION_RETRIES
    && budget.retriesConsumed <= budget.maxAdditionalRetries;
}
