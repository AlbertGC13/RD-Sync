import { describe, expect, it } from "vitest";
import {
  parseSessionAuthenticationAttemptRecord,
  type AcquireSessionAuthenticationLeaseResult,
  type ClaimSessionAuthenticationRetryResult,
  type CompleteAuthenticatedInput,
  type CompleteFailedInput,
  type GetOrCreateSessionAuthenticationAttemptResult,
  type RecordSessionAuthenticationSubmitBarrierResult,
  type ReconcileExpiredLeaseInput,
  type ReconcileExpiredLeaseResult,
  type SessionAuthenticationAttemptNotAppliedResult,
  type SessionAuthenticationAttemptRepository,
  type SessionAuthenticationAttemptRow,
} from "./session-authentication-attempt-repository";

const base: SessionAuthenticationAttemptRow = {
  bankCode: "popular", runId: "run-1", attemptId: "attempt-1", status: "active",
  interactionPhase: "no_credential_interaction", failureClass: null, operatorReason: null,
  retryCount: 0, ownerToken: null, generation: 0n, leaseExpiresAt: null, terminalAt: null,
  createdAt: new Date("2026-08-13T00:00:00.000Z"), updatedAt: new Date("2026-08-13T00:00:00.000Z"),
};

function parse(row: Partial<SessionAuthenticationAttemptRow>) {
  return parseSessionAuthenticationAttemptRecord({ ...base, ...row });
}

describe("parseSessionAuthenticationAttemptRecord", () => {
  it("parses valid active unowned and owned rows", () => {
    expect(parse({})).toMatchObject({ status: "active", generation: 0n, ownerToken: null });
    expect(parse({ ownerToken: "owner-1", leaseExpiresAt: new Date("2026-08-13T01:00:00.000Z") }))
      .toMatchObject({ status: "active", ownerToken: "owner-1" });
  });

  it("parses authenticated and failed terminal rows while preserving phase", () => {
    const terminalAt = new Date("2026-08-13T01:00:00.000Z");
    expect(parse({ status: "authenticated", interactionPhase: "credentials_may_have_reached_portal", terminalAt }))
      .toMatchObject({ status: "authenticated", interactionPhase: "credentials_may_have_reached_portal" });
    expect(parse({ status: "failed", interactionPhase: "submit_may_have_been_dispatched", failureClass: "interaction_outcome_uncertain", operatorReason: "authentication_attempt_requires_review", terminalAt }))
      .toMatchObject({ status: "failed", interactionPhase: "submit_may_have_been_dispatched", failureClass: "interaction_outcome_uncertain" });
  });

  it.each([
    ["transient_pre_interaction", "authentication_attempt_requires_review"],
    ["protected_or_mfa", "temporary_authentication_problem"],
    ["incompatible_flow", "protected_authentication_step_detected"],
    ["structural_configuration", "authentication_attempt_requires_review"],
    ["ownership_lost", "bank_login_configuration_requires_review"],
    ["interaction_outcome_uncertain", "temporary_authentication_problem"],
    ["unclassified_failure", "protected_authentication_step_detected"],
  ])("rejects mismatched failure class and operator reason: %s/%s", (failureClass, operatorReason) => {
    expect(parse({ status: "failed", failureClass, operatorReason, terminalAt: new Date() })).toBeNull();
  });

  it.each([
    { bankCode: " " }, { runId: "" }, { attemptId: "\t" },
    { status: "unknown" }, { interactionPhase: "unknown" },
    { status: "failed", failureClass: "unknown", operatorReason: "authentication_attempt_requires_review", terminalAt: new Date() },
    { status: "failed", failureClass: "unclassified_failure", operatorReason: "unknown", terminalAt: new Date() },
    { retryCount: -1 }, { retryCount: 3 }, { generation: -1n },
    { ownerToken: "owner-1" }, { leaseExpiresAt: new Date() },
    { status: "authenticated", ownerToken: "owner-1", leaseExpiresAt: new Date(), terminalAt: new Date() },
    { status: "active", terminalAt: new Date() },
    { status: "authenticated", failureClass: "unclassified_failure", terminalAt: new Date() },
    { status: "failed", terminalAt: new Date() },
  ])("rejects invalid durable row %#", (row) => {
    expect(parse(row)).toBeNull();
  });
});

type RepositoryMethods = Pick<SessionAuthenticationAttemptRepository,
  "getOrCreate" | "findExact" | "acquireLease" | "renewLease" | "beginCredentialInteraction" |
  "recordSubmitBarrier" | "claimRetry" | "completeAuthenticated" | "completeFailed" | "reconcileExpiredLease">;
void (null as unknown as RepositoryMethods);
declare const repository: SessionAuthenticationAttemptRepository;
if (false) {
  // @ts-expect-error The generic repository operation is intentionally unavailable.
  void repository.execute;
}

const submitBarrierResults: readonly RecordSessionAuthenticationSubmitBarrierResult[] = [
  { status: "recorded", record: null as unknown as never },
  { status: "already_recorded", record: null as unknown as never },
  { status: "invalid_transition" }, { status: "stale_owner" }, { status: "lease_expired" }, { status: "terminal" }, { status: "missing" },
];
const retryResults: readonly ClaimSessionAuthenticationRetryResult[] = [
  { status: "retry_claimed", retryCount: 1, record: null as unknown as never },
  { status: "retry_claimed", retryCount: 2, record: null as unknown as never },
  { status: "retry_exhausted" }, { status: "ineligible" }, { status: "stale_owner" }, { status: "lease_expired" }, { status: "terminal" }, { status: "missing" }, { status: "not_applied" },
];
const acquireLeaseResults: readonly AcquireSessionAuthenticationLeaseResult[] = [
  { status: "lease_acquired", owner: { identity: { bankCode: "popular", runId: "run-1", attemptId: "attempt-1" }, ownerToken: "owner-1", generation: 1n }, record: null as unknown as never },
  { status: "lease_held", record: null as unknown as never },
  { status: "reconciliation_required", record: null as unknown as never },
  { status: "terminal", record: null as unknown as never },
  { status: "missing" },
  { status: "not_applied" },
];
const owner = { identity: { bankCode: "popular", runId: "run-1", attemptId: "attempt-1" }, ownerToken: "owner-1", generation: 1n } as const;
const completeAuthenticatedInput: CompleteAuthenticatedInput = { owner };
const completeFailedInput: CompleteFailedInput = { owner, failureClass: "transient_pre_interaction", operatorReason: "temporary_authentication_problem" };
const reconcileExpiredLeaseInput: ReconcileExpiredLeaseInput = { identity: owner.identity };
const reconcileExpiredLeaseResults: readonly ReconcileExpiredLeaseResult[] = [
  { status: "lease_reconciled", record: null as unknown as never },
  { status: "lease_still_active", record: null as unknown as never },
  { status: "unowned", record: null as unknown as never },
  { status: "terminal", record: null as unknown as never },
  { status: "missing" }, { status: "not_applied" },
];
const notApplied: SessionAuthenticationAttemptNotAppliedResult = { status: "not_applied" };
const getOrCreateResults: readonly GetOrCreateSessionAuthenticationAttemptResult[] = [
  { status: "created", record: null as unknown as never },
  { status: "found", record: null as unknown as never },
  { status: "identity_conflict", existingAttemptId: "other-attempt" },
];
if (false) {
  const conflict: Extract<GetOrCreateSessionAuthenticationAttemptResult, { status: "identity_conflict" }> = {
    status: "identity_conflict", existingAttemptId: "other-attempt",
  };
  // @ts-expect-error An identity conflict is deliberately non-authorizing.
  void conflict.ownerToken;
  // @ts-expect-error An identity conflict does not expose the existing aggregate record.
  void conflict.record;
  // @ts-expect-error Terminal timestamps come from PostgreSQL.
  void ({ owner, terminalAt: new Date() } satisfies CompleteAuthenticatedInput);
  // @ts-expect-error Terminal timestamps come from PostgreSQL.
  void ({ owner, failureClass: "transient_pre_interaction", operatorReason: "temporary_authentication_problem", terminalAt: new Date() } satisfies CompleteFailedInput);
  // @ts-expect-error Lease reconciliation time comes from PostgreSQL.
  void ({ identity: owner.identity, reconciledAt: new Date() } satisfies ReconcileExpiredLeaseInput);
}
void [submitBarrierResults, retryResults, acquireLeaseResults, completeAuthenticatedInput, completeFailedInput, reconcileExpiredLeaseInput, reconcileExpiredLeaseResults, notApplied, getOrCreateResults];
