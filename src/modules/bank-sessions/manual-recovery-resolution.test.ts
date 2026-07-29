import { describe, expect, expectTypeOf, it, vi } from "vitest";

import { BANK_AUTOLOGIN_ACTIONS } from "../audit/bank-actions";
import {
  authorizeManualRecoveryResolution,
  createManualRecoveryResolutionAuditMetadata,
  type ManualRecoveryResolutionDecision,
  type ManualRecoveryResolutionRateLimitGate,
} from "./manual-recovery-resolution";

const admin = { operatorId: "admin-1", roles: ["admin"] };
const resolution = {
  actor: admin,
  decision: { outcome: "safe_to_retry", reason: "verified_no_mutation" } as const,
};

const validDecisions: readonly ManualRecoveryResolutionDecision[] = [
  { outcome: "safe_to_retry", reason: "verified_no_mutation" },
  { outcome: "mutation_confirmed", reason: "verified_mutation" },
  { outcome: "resolved_no_retry", reason: "closed_without_retry" },
];

const invalidDecisions = [
  { outcome: "safe_to_retry", reason: "verified_mutation" },
  { outcome: "safe_to_retry", reason: "closed_without_retry" },
  { outcome: "mutation_confirmed", reason: "verified_no_mutation" },
  { outcome: "mutation_confirmed", reason: "closed_without_retry" },
  { outcome: "resolved_no_retry", reason: "verified_no_mutation" },
  { outcome: "resolved_no_retry", reason: "verified_mutation" },
] as const;

type ExactManualRecoveryResolutionDecision =
  | { readonly outcome: "safe_to_retry"; readonly reason: "verified_no_mutation" }
  | { readonly outcome: "mutation_confirmed"; readonly reason: "verified_mutation" }
  | { readonly outcome: "resolved_no_retry"; readonly reason: "closed_without_retry" };

// If this stops being an error, the production type widened to independently
// combinable outcome/reason unions.
// @ts-expect-error invalid outcome/reason pairs must not type-check
const invalidDecisionTypeContract: ManualRecoveryResolutionDecision = {
  outcome: "safe_to_retry",
  reason: "verified_mutation",
};
void invalidDecisionTypeContract;

describe("manual recovery resolution policy", () => {
  it("has exactly the three approved discriminated decision shapes", () => {
    expectTypeOf<ManualRecoveryResolutionDecision>().toEqualTypeOf<ExactManualRecoveryResolutionDecision>();
  });

  it("authorizes an admin with an immutable discriminated decision without assigning resolvedAt", async () => {
    const gate: ManualRecoveryResolutionRateLimitGate = { allow: vi.fn(async () => true) };

    const command = await authorizeManualRecoveryResolution(resolution, gate);

    expect(gate.allow).toHaveBeenCalledWith("admin-1");
    expect(command).toEqual({
      operatorId: "admin-1",
      decision: { outcome: "safe_to_retry", reason: "verified_no_mutation" },
    });
    expect("resolvedAt" in command).toBe(false);
    expect(Object.isFrozen(command)).toBe(true);
    expect(Object.isFrozen(command.decision)).toBe(true);
  });

  it("rejects a non-admin before the rate-limit gate can permit persistence", async () => {
    const gate: ManualRecoveryResolutionRateLimitGate = { allow: vi.fn(async () => true) };

    await expect(authorizeManualRecoveryResolution({ ...resolution, actor: { operatorId: "reviewer-1", roles: ["reviewer"] } }, gate))
      .rejects.toThrow("Admin role required for manual recovery resolution");

    expect(gate.allow).not.toHaveBeenCalled();
  });

  it("rejects a rate-limited admin without creating an authorized command", async () => {
    const denied: ManualRecoveryResolutionRateLimitGate = { allow: vi.fn(async () => false) };

    await expect(authorizeManualRecoveryResolution(resolution, denied)).rejects.toThrow("Manual recovery resolution rate limited");
    expect(denied.allow).toHaveBeenCalledOnce();
  });

  it("accepts each representable decision but rejects every unknown invalid permutation before the gate", async () => {
    const gate: ManualRecoveryResolutionRateLimitGate = { allow: vi.fn(async () => true) };

    for (const decision of validDecisions) {
      await expect(authorizeManualRecoveryResolution({ actor: admin, decision }, gate)).resolves.toMatchObject({ decision });
    }
    for (const decision of invalidDecisions) {
      await expect(authorizeManualRecoveryResolution({ actor: admin, decision } as never, gate))
        .rejects.toThrow("Manual recovery decision is invalid");
    }
    await expect(authorizeManualRecoveryResolution({
      actor: admin,
      decision: { outcome: "unknown", reason: "verified_no_mutation" },
    } as never, gate)).rejects.toThrow("Manual recovery decision is invalid");
    await expect(authorizeManualRecoveryResolution({ ...resolution, actor: { operatorId: "  ", roles: ["admin"] } }, gate))
      .rejects.toThrow("Manual recovery operator ID must be nonblank");

    expect(gate.allow).toHaveBeenCalledTimes(3);
  });

  it("rejects malformed decision values before the rate-limit gate", async () => {
    const gate: ManualRecoveryResolutionRateLimitGate = { allow: vi.fn(async () => true) };
    const malformedDecisions: unknown[] = [
      null, "decision", 1, true, [], {}, { outcome: "safe_to_retry" },
      { reason: "verified_no_mutation" }, { outcome: "unknown", reason: "verified_no_mutation" },
      { outcome: "safe_to_retry", reason: "unknown" },
    ];

    for (const decision of malformedDecisions) {
      await expect(authorizeManualRecoveryResolution({ actor: admin, decision } as never, gate))
        .rejects.toThrow("Manual recovery decision is invalid");
    }

    expect(gate.allow).not.toHaveBeenCalled();
  });

  it("publishes only allowlisted resolution audit metadata", () => {
    const metadata = createManualRecoveryResolutionAuditMetadata({
      bankCode: "popular",
      expiredEventId: "event-1",
      runId: "run-1",
      decision: { outcome: "resolved_no_retry", reason: "closed_without_retry" },
      operatorId: "admin-1",
      resolvedAt: "2026-07-20T15:10:00.000Z",
      consumerClaimToken: "must-not-leak",
      internalError: "must-not-leak",
    });

    expect(BANK_AUTOLOGIN_ACTIONS).toMatchObject({
      CONSUMER_RESERVED: "bank_autologin.consumer_reserved",
      MUTATION_STARTED: "bank_autologin.mutation_started",
      MANUAL_RECOVERY_REQUIRED: "bank_autologin.manual_recovery_required",
      MANUAL_RECOVERY_RESOLVED: "bank_autologin.manual_recovery_resolved",
      REPLAY_AUTHORIZED: "bank_autologin.replay_authorized",
    });
    expect(metadata).toEqual({
      bankCode: "popular",
      expiredEventId: "event-1",
      runId: "run-1",
      outcome: "resolved_no_retry",
      operatorId: "admin-1",
      reason: "closed_without_retry",
      resolvedAt: "2026-07-20T15:10:00.000Z",
    });
  });
});
