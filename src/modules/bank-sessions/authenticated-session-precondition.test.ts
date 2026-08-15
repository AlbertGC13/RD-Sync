import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  coordinateAuthenticatedSessionPrecondition,
  type AuthenticatedSessionMutationRunner,
  type AuthenticatedSessionStateCoordinator,
} from "./authenticated-session-precondition";
import type { AuthenticationMutationAuthority } from "./authentication-mutation-authority";
import type { CoordinateAuthenticatedSessionStateInput } from "./ensure-authenticated-session";

const input: CoordinateAuthenticatedSessionStateInput = {
  identity: { bankCode: "popular", runId: "run-1", attemptId: "attempt-1" },
  ownerToken: "caller-owner",
  leaseDurationMs: 1_000,
};
const authority = {} as AuthenticationMutationAuthority;
const operatorReasons = [
  "temporary_authentication_problem",
  "protected_authentication_step_detected",
  "bank_login_configuration_requires_review",
  "authentication_attempt_requires_review",
] as const;

function setup(coordinatorResult: unknown, runnerResult: unknown) {
  const coordinator = { coordinate: vi.fn().mockResolvedValue(coordinatorResult) };
  const runner = { run: vi.fn().mockResolvedValue(runnerResult) };
  return { coordinator, runner };
}

function precondition(coordinatorResult: unknown, ...runnerResults: [unknown] | []) {
  const runnerResult = runnerResults.length === 0 ? { status: "authenticated" } : runnerResults[0];
  const { coordinator, runner } = setup(coordinatorResult, runnerResult);
  return { coordinator, runner, result: coordinateAuthenticatedSessionPrecondition(input, { coordinator: coordinator as AuthenticatedSessionStateCoordinator, runner: runner as AuthenticatedSessionMutationRunner }) };
}

describe("coordinateAuthenticatedSessionPrecondition", () => {
  it.each(["existing", "observed"] as const)("returns authenticated from coordinator %s without running a mutation", async (source) => {
    const { runner, result } = precondition({ status: "authenticated", source });
    await expect(result).resolves.toEqual({ status: "authenticated" });
    expect(runner.run).not.toHaveBeenCalled();
  });

  it.each(["session_probe_unavailable", "ownership_changed", "state_changed"] as const)("maps coordinator retry %s to delivery retry", async (reason) => {
    const { runner, result } = precondition({ status: "retry_later", reason });
    await expect(result).resolves.toEqual({ status: "retry_delivery" });
    expect(runner.run).not.toHaveBeenCalled();
  });

  it.each(["lease_held", "active_mutation_owner"] as const)("preserves coordinator in-progress %s", async (reason) => {
    await expect(precondition({ status: "in_progress", reason }).result).resolves.toEqual({ status: "in_progress" });
  });

  it.each([...operatorReasons, "identity_conflict", "restoration_state_conflict"] as const)("preserves safe coordinator operator reason %s", async (reason) => {
    await expect(precondition({ status: "needs_operator_action", reason }).result).resolves.toEqual({ status: "needs_operator_action", reason });
  });

  it.each(["cancelled", "invalid_request"] as const)("preserves coordinator %s", async (status) => {
    await expect(precondition({ status }).result).resolves.toEqual({ status });
  });

  it("coordinates before handing the exact authority to the runner once", async () => {
    const { coordinator, runner, result } = precondition({ status: "authentication_required", authority });
    await expect(result).resolves.toEqual({ status: "authenticated" });
    expect(runner.run).toHaveBeenCalledExactlyOnceWith(authority);
    expect(coordinator.coordinate).toHaveBeenCalledExactlyOnceWith(input);
    expect(coordinator.coordinate.mock.invocationCallOrder[0]).toBeLessThan(runner.run.mock.invocationCallOrder[0]);
  });

  it("runs after authority minting even if cancellation occurs before the runner", async () => {
    const controller = new AbortController();
    const coordinator = { coordinate: vi.fn().mockImplementation(async () => { controller.abort(); return { status: "authentication_required", authority }; }) };
    const runner = { run: vi.fn().mockResolvedValue({ status: "authenticated" }) };
    await expect(coordinateAuthenticatedSessionPrecondition({ ...input, signal: controller.signal }, { coordinator: coordinator as AuthenticatedSessionStateCoordinator, runner: runner as AuthenticatedSessionMutationRunner })).resolves.toEqual({ status: "authenticated" });
    expect(runner.run).toHaveBeenCalledExactlyOnceWith(authority);
  });

  it.each([
    [{ status: "authenticated" }, { status: "authenticated" }],
    [{ status: "retry_claimed" }, { status: "retry_delivery" }],
    [{ status: "retry_exhausted" }, { status: "needs_operator_action", reason: "temporary_authentication_problem" }],
    [{ status: "unresolved" }, { status: "needs_operator_action", reason: "authentication_attempt_requires_review" }],
  ])("maps runner result %# safely", async (runnerResult, expected) => {
    await expect(precondition({ status: "authentication_required", authority }, runnerResult).result).resolves.toEqual(expected);
  });

  it.each(operatorReasons)("preserves safe runner failure reason %s", async (reason) => {
    await expect(precondition({ status: "authentication_required", authority }, { status: "failed", reason }).result).resolves.toEqual({ status: "needs_operator_action", reason });
  });

  it.each([
    null, undefined, true, 1, "authenticated", [], {}, { status: "unknown" }, { status: "failed" },
    { status: "failed", reason: "wrong" }, { status: "authenticated", token: "leak" },
    { status: "authenticated", authority }, { status: "authenticated", owner: "leak" }, { status: "authenticated", generation: 1 },
  ])("fails closed for malformed runner output %#", async (runnerResult) => {
    const state = await precondition({ status: "authentication_required", authority }, runnerResult).result;
    expect(state).toEqual({ status: "needs_operator_action", reason: "authentication_attempt_requires_review" });
    expect(JSON.stringify(state)).not.toMatch(/authority|token|owner|generation|error|leak/i);
  });

  it("fails closed when the runner throws", async () => {
    const { coordinator, runner } = setup({ status: "authentication_required", authority }, { status: "authenticated" });
    runner.run.mockRejectedValueOnce(new Error("raw private diagnostic"));
    await expect(coordinateAuthenticatedSessionPrecondition(input, { coordinator: coordinator as AuthenticatedSessionStateCoordinator, runner: runner as AuthenticatedSessionMutationRunner })).resolves.toEqual({ status: "needs_operator_action", reason: "authentication_attempt_requires_review" });
  });

  it("calls each injected dependency at most once without retrying", async () => {
    const { coordinator, runner } = setup({ status: "authentication_required", authority }, { status: "unresolved" });
    await coordinateAuthenticatedSessionPrecondition(input, { coordinator, runner });
    expect(coordinator.coordinate).toHaveBeenCalledTimes(1);
    expect(runner.run).toHaveBeenCalledTimes(1);
  });

  it("exposes no authority-bearing result or forbidden capability surface", () => {
    const source = readFileSync(fileURLToPath(new URL("./authenticated-session-precondition.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(/claimAuthenticationMutationAuthority|ClaimedAuthenticationMutationAuthority/i);
    expect(source).not.toMatch(/collection|audit|queue|browser|credential|repository/i);
  });
});
