import { describe, expect, it } from "vitest";
import {
  classifySessionAuthenticationFailure,
  createSessionAuthenticationAttempt,
  deriveSessionAuthenticationRetryDisposition,
  MAX_SESSION_AUTHENTICATION_RETRIES,
  transitionSessionAuthenticationAttempt,
  type CredentialInteractionPhase,
  type SessionAuthenticationAttempt,
  type SessionAuthenticationFailureCause,
} from "./session-authentication-attempt";

const identity = { bankCode: "popular", runId: "run-1", attemptId: "attempt-1" };
const phases: readonly CredentialInteractionPhase[] = [
  "no_credential_interaction",
  "credentials_may_have_reached_portal",
  "submit_may_have_been_dispatched",
];

function attemptAt(phase: CredentialInteractionPhase): SessionAuthenticationAttempt {
  let attempt: SessionAuthenticationAttempt = createSessionAuthenticationAttempt(identity);
  if (phase !== "no_credential_interaction") {
    attempt = transitionSessionAuthenticationAttempt(attempt, { type: "begin_credential_interaction" });
  }
  if (phase === "submit_may_have_been_dispatched") {
    attempt = transitionSessionAuthenticationAttempt(attempt, { type: "record_submit_barrier" });
  }
  return attempt;
}

function failAttemptAt(
  phase: CredentialInteractionPhase,
  cause: SessionAuthenticationFailureCause,
): Extract<SessionAuthenticationAttempt, { status: "failed" }> {
  const attempt = transitionSessionAuthenticationAttempt(attemptAt(phase), { type: "fail", cause });
  if (attempt.status !== "failed") throw new Error("Expected failed session authentication attempt");
  return attempt;
}

function retryDisposition(
  attempt: Exclude<SessionAuthenticationAttempt, { status: "active" }>,
  retriesConsumed = 0,
) {
  return deriveSessionAuthenticationRetryDisposition(attempt, {
    retriesConsumed,
    maxAdditionalRetries: MAX_SESSION_AUTHENTICATION_RETRIES,
  });
}

describe("session authentication attempt", () => {
  it("creates an active attempt with its identity and no credential interaction", () => {
    expect(createSessionAuthenticationAttempt(identity)).toEqual({
      status: "active",
      identity,
      interactionPhase: "no_credential_interaction",
    });
  });

  it("authenticates an already-valid session without advancing interaction", () => {
    expect(transitionSessionAuthenticationAttempt(attemptAt("no_credential_interaction"), { type: "confirm_authenticated" }))
      .toMatchObject({ status: "authenticated", interactionPhase: "no_credential_interaction" });
  });

  it("records the credential interaction boundary", () => {
    expect(transitionSessionAuthenticationAttempt(attemptAt("no_credential_interaction"), { type: "begin_credential_interaction" }))
      .toMatchObject({ status: "active", interactionPhase: "credentials_may_have_reached_portal" });
  });

  it("rejects a submit barrier before credential interaction", () => {
    expect(() => transitionSessionAuthenticationAttempt(attemptAt("no_credential_interaction"), { type: "record_submit_barrier" }))
      .toThrow("Invalid session authentication attempt transition");
  });

  it("records the submit barrier after credential interaction", () => {
    expect(transitionSessionAuthenticationAttempt(attemptAt("credentials_may_have_reached_portal"), { type: "record_submit_barrier" }))
      .toMatchObject({ status: "active", interactionPhase: "submit_may_have_been_dispatched" });
  });

  it("rejects repeated interaction boundary events", () => {
    expect(() => transitionSessionAuthenticationAttempt(attemptAt("credentials_may_have_reached_portal"), { type: "begin_credential_interaction" }))
      .toThrow("Invalid session authentication attempt transition");
    expect(() => transitionSessionAuthenticationAttempt(attemptAt("submit_may_have_been_dispatched"), { type: "record_submit_barrier" }))
      .toThrow("Invalid session authentication attempt transition");
  });

  it.each(phases)("preserves %s when authentication succeeds", (phase) => {
    expect(transitionSessionAuthenticationAttempt(attemptAt(phase), { type: "confirm_authenticated" }))
      .toMatchObject({ status: "authenticated", interactionPhase: phase });
  });

  it.each(phases)("preserves %s when failure occurs", (phase) => {
    expect(transitionSessionAuthenticationAttempt(attemptAt(phase), { type: "fail", cause: "unknown_failure" }))
      .toMatchObject({ status: "failed", interactionPhase: phase });
  });

  it.each([0, 1] as const)("retries transient pre-interaction failure with %i of 2 slots consumed", (retriesConsumed) => {
    const failed = failAttemptAt("no_credential_interaction", "transient_infrastructure");
    expect(retryDisposition(failed, retriesConsumed)).toBe("retry_automatically");
  });

  it("does not retry when both automatic retry slots are consumed", () => {
    const failed = failAttemptAt("no_credential_interaction", "transient_infrastructure");
    expect(retryDisposition(failed, 2)).toBe("do_not_retry");
  });

  it("does not retry a correct class in the wrong interaction phase", () => {
    const failed = {
      ...failAttemptAt("no_credential_interaction", "transient_infrastructure"),
      interactionPhase: "credentials_may_have_reached_portal" as const,
    };
    expect(retryDisposition(failed)).toBe("do_not_retry");
  });

  it("does not retry a correct phase with the wrong failure class", () => {
    const failed = {
      ...failAttemptAt("no_credential_interaction", "transient_infrastructure"),
      failureClass: "unclassified_failure" as const,
    };
    expect(retryDisposition(failed)).toBe("do_not_retry");
  });

  it.each([
    { retriesConsumed: -1, maxAdditionalRetries: 2 },
    { retriesConsumed: 0.5, maxAdditionalRetries: 2 },
    { retriesConsumed: 3, maxAdditionalRetries: 2 },
    { retriesConsumed: 0, maxAdditionalRetries: 1 },
    { retriesConsumed: 0, maxAdditionalRetries: 3 },
  ])("fails closed for malformed retry budget %#", (budget) => {
    const failed = failAttemptAt("no_credential_interaction", "transient_infrastructure");
    expect(deriveSessionAuthenticationRetryDisposition(failed, budget as never)).toBe("do_not_retry");
  });

  it.each(["credentials_may_have_reached_portal", "submit_may_have_been_dispatched"] as const)(
    "classifies transient failure after %s as uncertain and non-retryable",
    (phase) => {
      const failed = failAttemptAt(phase, "transient_infrastructure");
      expect(failed).toMatchObject({ failureClass: "interaction_outcome_uncertain" });
      expect(retryDisposition(failed)).toBe("do_not_retry");
    },
  );

  it.each(phases)("never retries protected or MFA failure at %s", (phase) => {
    const failed = failAttemptAt(phase, "protected_or_mfa_detected");
    expect(retryDisposition(failed)).toBe("do_not_retry");
  });

  it.each(phases)("never retries incompatible flow failure at %s", (phase) => {
    const failed = failAttemptAt(phase, "incompatible_flow_detected");
    expect(retryDisposition(failed)).toBe("do_not_retry");
  });

  it.each(["structural_configuration_error", "ownership_lost", "unknown_failure"] as const)(
    "does not retry %s",
    (cause) => {
      const failed = failAttemptAt("no_credential_interaction", cause);
      expect(retryDisposition(failed)).toBe("do_not_retry");
    },
  );

  it.each([
    { type: "begin_credential_interaction" },
    { type: "record_submit_barrier" },
    { type: "confirm_authenticated" },
    { type: "fail", cause: "unknown_failure" },
  ] as const)("rejects $type from every terminal outcome", (event) => {
    const authenticated = transitionSessionAuthenticationAttempt(attemptAt("no_credential_interaction"), { type: "confirm_authenticated" });
    const failed = transitionSessionAuthenticationAttempt(attemptAt("no_credential_interaction"), { type: "fail", cause: "unknown_failure" });
    for (const terminal of [authenticated, failed]) {
      expect(() => transitionSessionAuthenticationAttempt(terminal, event))
        .toThrow("Invalid session authentication attempt transition");
    }
  });

  it.each(phases)("preserves attempt identity through a terminal transition from %s", (phase) => {
    expect(transitionSessionAuthenticationAttempt(attemptAt(phase), { type: "confirm_authenticated" }))
      .toMatchObject({ identity });
  });

  it.each([
    ["no_credential_interaction", "transient_infrastructure", "transient_pre_interaction", "temporary_authentication_problem"],
    ["credentials_may_have_reached_portal", "transient_infrastructure", "interaction_outcome_uncertain", "authentication_attempt_requires_review"],
    ["no_credential_interaction", "protected_or_mfa_detected", "protected_or_mfa", "protected_authentication_step_detected"],
    ["no_credential_interaction", "incompatible_flow_detected", "incompatible_flow", "bank_login_configuration_requires_review"],
    ["no_credential_interaction", "structural_configuration_error", "structural_configuration", "bank_login_configuration_requires_review"],
    ["no_credential_interaction", "ownership_lost", "ownership_lost", "authentication_attempt_requires_review"],
    ["no_credential_interaction", "unknown_failure", "unclassified_failure", "authentication_attempt_requires_review"],
  ] as const)("maps %s and %s to the exact safe classification", (phase, cause, failureClass, operatorReason) => {
    expect(classifySessionAuthenticationFailure(phase, cause as SessionAuthenticationFailureCause))
      .toEqual({ failureClass, operatorReason });
  });
});
