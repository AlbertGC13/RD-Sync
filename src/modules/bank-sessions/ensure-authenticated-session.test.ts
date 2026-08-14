import { describe, expect, it, vi } from "vitest";
import { coordinateAuthenticatedSessionState, type AuthenticatedSessionCoordinatorDependencies } from "./ensure-authenticated-session";
import type { SessionAuthenticationAttemptRecord } from "./session-authentication-attempt-repository";

const identity = { bankCode: "popular", runId: "run-1", attemptId: "attempt-1" };
const owner = { identity, ownerToken: "db-owner", generation: 1n };
const fields = () => ({ identity, interactionPhase: "no_credential_interaction" as const, retryCount: 0, generation: 0n, createdAt: new Date(), updatedAt: new Date() });
const active = (): SessionAuthenticationAttemptRecord => ({ ...fields(), status: "active", ownerToken: null, leaseExpiresAt: null, failureClass: null, operatorReason: null, terminalAt: null });
const owned = (): SessionAuthenticationAttemptRecord => ({ ...fields(), status: "active", ownerToken: "other", leaseExpiresAt: new Date(), failureClass: null, operatorReason: null, terminalAt: null });
const authenticated = (): SessionAuthenticationAttemptRecord => ({ ...fields(), status: "authenticated", ownerToken: null, leaseExpiresAt: null, failureClass: null, operatorReason: null, terminalAt: new Date() });
function failed(operatorReason: "temporary_authentication_problem" | "protected_authentication_step_detected" | "bank_login_configuration_requires_review" | "authentication_attempt_requires_review"): SessionAuthenticationAttemptRecord {
  if (operatorReason === "temporary_authentication_problem") return { ...fields(), status: "failed", ownerToken: null, leaseExpiresAt: null, terminalAt: new Date(), operatorReason, failureClass: "transient_pre_interaction" };
  if (operatorReason === "protected_authentication_step_detected") return { ...fields(), status: "failed", ownerToken: null, leaseExpiresAt: null, terminalAt: new Date(), operatorReason, failureClass: "protected_or_mfa" };
  if (operatorReason === "bank_login_configuration_requires_review") return { ...fields(), status: "failed", ownerToken: null, leaseExpiresAt: null, terminalAt: new Date(), operatorReason, failureClass: "incompatible_flow" };
  return { ...fields(), status: "failed", ownerToken: null, leaseExpiresAt: null, terminalAt: new Date(), operatorReason, failureClass: "ownership_lost" };
}

function setup(overrides: Partial<AuthenticatedSessionCoordinatorDependencies> = {}) {
  const attempts = {
    getOrCreate: vi.fn().mockResolvedValue({ status: "found", record: active() }),
    findExact: vi.fn().mockResolvedValue({ status: "missing" }),
    acquireLease: vi.fn().mockResolvedValue({ status: "lease_acquired", owner, record: owned() }),
    reconcileExpiredLease: vi.fn().mockResolvedValue({ status: "unowned", record: active() }),
    completeAuthenticated: vi.fn().mockResolvedValue({ status: "authenticated", record: authenticated() }),
  };
  const probe = { observe: vi.fn().mockResolvedValue({ status: "authenticated", observedAt: new Date() }) };
  const resolver = { resolveObservedRestoration: vi.fn().mockResolvedValue({ status: "resolved", evidence: { authenticatedAt: new Date() } }) };
  return { attempts, probe, resolver, dependencies: { attempts, probe, completion: { mode: "attempt_only" }, ...overrides } as AuthenticatedSessionCoordinatorDependencies };
}
function coordinate(dependencies: AuthenticatedSessionCoordinatorDependencies, input = {}) { return coordinateAuthenticatedSessionState({ identity, ownerToken: "caller-owner", leaseDurationMs: 1_000, ...input }, dependencies); }
function expectNoDurableMutation(attempts: ReturnType<typeof setup>["attempts"], resolver: ReturnType<typeof setup>["resolver"]) {
  expect(attempts.getOrCreate).not.toHaveBeenCalled(); expect(attempts.acquireLease).not.toHaveBeenCalled(); expect(attempts.reconcileExpiredLease).not.toHaveBeenCalled(); expect(attempts.completeAuthenticated).not.toHaveBeenCalled(); expect(resolver.resolveObservedRestoration).not.toHaveBeenCalled();
}

describe("coordinateAuthenticatedSessionState", () => {
  it.each([{ identity: { ...identity, bankCode: " " } }, { ownerToken: " " }, { leaseDurationMs: 0 }, { leaseDurationMs: 1.5 }])("rejects invalid durable input without dependencies: %#", async (input) => {
    const { attempts, probe, dependencies } = setup();
    await expect(coordinate(dependencies, input)).resolves.toEqual({ status: "invalid_request" });
    expect(attempts.getOrCreate).not.toHaveBeenCalled(); expect(probe.observe).not.toHaveBeenCalled();
  });

  it("returns cancelled before dependencies for an aborted signal", async () => {
    const controller = new AbortController(); controller.abort(); const { attempts, dependencies } = setup();
    await expect(coordinate(dependencies, { signal: controller.signal })).resolves.toEqual({ status: "cancelled" }); expect(attempts.getOrCreate).not.toHaveBeenCalled();
  });
  it("maps terminal records without probing", async () => {
    const { attempts, probe, dependencies } = setup(); attempts.findExact.mockResolvedValueOnce({ status: "found", record: authenticated() });
    await expect(coordinate(dependencies)).resolves.toEqual({ status: "authenticated", source: "existing" }); expect(probe.observe).not.toHaveBeenCalled();
  });
  it.each(["temporary_authentication_problem", "protected_authentication_step_detected", "bank_login_configuration_requires_review", "authentication_attempt_requires_review"] as const)("maps durable failure %s safely", async (reason) => {
    const { attempts, dependencies } = setup(); attempts.findExact.mockResolvedValueOnce({ status: "found", record: failed(reason) });
    await expect(coordinate(dependencies)).resolves.toEqual({ status: "needs_operator_action", reason });
  });
  it("hides identity-conflict attempt IDs", async () => {
    const { attempts, dependencies } = setup(); attempts.getOrCreate.mockResolvedValueOnce({ status: "identity_conflict", existingAttemptId: "conflicting-attempt-id" });
    const result = await coordinate(dependencies); expect(result).toEqual({ status: "needs_operator_action", reason: "identity_conflict" }); expect(JSON.stringify(result)).not.toContain("conflicting-attempt-id");
  });
  it("requires authentication without leasing or retrying when unowned probe is unauthenticated", async () => {
    const { attempts, probe, resolver, dependencies } = setup(); probe.observe.mockResolvedValueOnce({ status: "unauthenticated" });
    await expect(coordinate(dependencies)).resolves.toEqual({ status: "authentication_required" }); expectNoDurableMutation(attempts, resolver); expect("claimRetry" in attempts).toBe(false);
  });
  it.each(["unavailable", "throws"] as const)("maps probe %s to a safe retry", async (outcome) => {
    const { attempts, probe, resolver, dependencies } = setup();
    if (outcome === "throws") probe.observe.mockRejectedValueOnce(new Error("internal")); else probe.observe.mockResolvedValueOnce({ status: "unavailable" });
    await expect(coordinate(dependencies)).resolves.toEqual({ status: "retry_later", reason: "session_probe_unavailable" }); expectNoDurableMutation(attempts, resolver);
  });
  it("cancels when the caller aborts during probing", async () => {
    const controller = new AbortController(); const { probe, attempts, resolver, dependencies } = setup(); probe.observe.mockImplementationOnce(async () => { controller.abort(); return { status: "authenticated", observedAt: new Date() }; });
    await expect(coordinate(dependencies, { signal: controller.signal })).resolves.toEqual({ status: "cancelled" }); expectNoDurableMutation(attempts, resolver);
  });
  it.each([
    { label: "created active", created: { status: "created", record: active() }, expected: { status: "authenticated", source: "observed" } },
    { label: "concurrently active", created: { status: "found", record: active() }, expected: { status: "authenticated", source: "observed" } },
    { label: "concurrently authenticated", created: { status: "found", record: authenticated() }, expected: { status: "authenticated", source: "existing" } },
    { label: "concurrently failed", created: { status: "found", record: failed("temporary_authentication_problem") }, expected: { status: "needs_operator_action", reason: "temporary_authentication_problem" } },
    { label: "identity conflict", created: { status: "identity_conflict", existingAttemptId: "other" }, expected: { status: "needs_operator_action", reason: "identity_conflict" } },
  ])("probes before getOrCreate and safely maps missing $label races", async ({ created, expected }) => {
    const { attempts, probe, dependencies } = setup(); attempts.getOrCreate.mockResolvedValueOnce(created);
    await expect(coordinate(dependencies)).resolves.toEqual(expected); expect(probe.observe.mock.invocationCallOrder[0]).toBeLessThan(attempts.getOrCreate.mock.invocationCallOrder[0]);
  });
  it("classifies a concurrently owned getOrCreate result without a second probe", async () => {
    const { attempts, probe, dependencies } = setup(); attempts.getOrCreate.mockResolvedValueOnce({ status: "found", record: owned() }); attempts.acquireLease.mockResolvedValueOnce({ status: "lease_held", record: owned() });
    await expect(coordinate(dependencies)).resolves.toEqual({ status: "in_progress", reason: "lease_held" }); expect(probe.observe).toHaveBeenCalledTimes(1);
  });
  it("classifies an owned active attempt from the lease path without probing", async () => {
    const { attempts, probe, dependencies } = setup(); attempts.findExact.mockResolvedValueOnce({ status: "found", record: owned() }); attempts.acquireLease.mockResolvedValueOnce({ status: "lease_held", record: owned() });
    await expect(coordinate(dependencies)).resolves.toEqual({ status: "in_progress", reason: "lease_held" }); expect(probe.observe).not.toHaveBeenCalled();
  });
  it("closes observed authentication in attempt-only mode", async () => {
    const { attempts, dependencies } = setup(); attempts.findExact.mockResolvedValueOnce({ status: "found", record: active() });
    await expect(coordinate(dependencies)).resolves.toEqual({ status: "authenticated", source: "observed" }); expect(attempts.getOrCreate).not.toHaveBeenCalled(); expect(attempts.completeAuthenticated).toHaveBeenCalledWith({ owner });
  });
  it("allows only the lease owner to complete concurrent observations", async () => {
    const { attempts, dependencies } = setup(); attempts.acquireLease.mockResolvedValueOnce({ status: "lease_acquired", owner, record: owned() }).mockResolvedValueOnce({ status: "lease_held", record: owned() });
    const results = await Promise.all([coordinate(dependencies), coordinate(dependencies)]); expect(results).toContainEqual({ status: "authenticated", source: "observed" }); expect(attempts.completeAuthenticated).toHaveBeenCalledTimes(1);
  });
  it("reconciles once, then re-probes unowned state before reacquiring", async () => {
    const { attempts, probe, dependencies } = setup(); attempts.acquireLease.mockResolvedValueOnce({ status: "reconciliation_required", record: owned() });
    await expect(coordinate(dependencies)).resolves.toEqual({ status: "authenticated", source: "observed" }); expect(attempts.reconcileExpiredLease).toHaveBeenCalledTimes(1); expect(probe.observe).toHaveBeenCalledTimes(2); expect(attempts.acquireLease).toHaveBeenCalledTimes(2);
  });
  it("maps reconciled terminal state without reacquiring", async () => {
    const { attempts, dependencies } = setup(); attempts.acquireLease.mockResolvedValueOnce({ status: "reconciliation_required", record: owned() }); attempts.reconcileExpiredLease.mockResolvedValueOnce({ status: "terminal", record: authenticated() });
    await expect(coordinate(dependencies)).resolves.toEqual({ status: "authenticated", source: "existing" }); expect(attempts.acquireLease).toHaveBeenCalledTimes(1);
  });
  it.each(["stale_owner", "lease_expired", "not_applied"] as const)("maps completion %s without a second close", async (status) => {
    const { attempts, dependencies } = setup(); attempts.completeAuthenticated.mockResolvedValueOnce({ status });
    await expect(coordinate(dependencies)).resolves.toEqual({ status: "retry_later", reason: "ownership_changed" }); expect(attempts.completeAuthenticated).toHaveBeenCalledTimes(1);
  });
  it.each(["missing", "not_applied"] as const)("refetches acquire race %s and maps its terminal state", async (status) => {
    const { attempts, dependencies } = setup(); attempts.acquireLease.mockResolvedValueOnce({ status }); attempts.findExact.mockResolvedValueOnce({ status: "found", record: authenticated() });
    await expect(coordinate(dependencies)).resolves.toEqual({ status: "authenticated", source: "existing" }); expect(attempts.findExact).toHaveBeenCalledTimes(1);
  });
  it.each(["resolved", "already_resolved"] as const)("uses only resolver for expiry restoration %s", async (status) => {
    const { attempts, resolver, dependencies: base } = setup(); const dependencies = { ...base, completion: { mode: "expiry_restoration" as const, resolver } }; resolver.resolveObservedRestoration.mockResolvedValueOnce(status === "resolved" ? { status, evidence: { authenticatedAt: new Date() } } : { status });
    await expect(coordinate(dependencies)).resolves.toEqual({ status: "authenticated", source: "observed" }); expect(resolver.resolveObservedRestoration).toHaveBeenCalledWith(owner); expect(attempts.completeAuthenticated).not.toHaveBeenCalled();
  });
  it.each(["active_mutation_owner", "missing", "identity_mismatch", "episode_not_resolvable", "terminal_conflict"] as const)("maps expiry resolver %s safely without fallback", async (status) => {
    const { attempts, resolver, dependencies: base } = setup(); const dependencies = { ...base, completion: { mode: "expiry_restoration" as const, resolver } }; resolver.resolveObservedRestoration.mockResolvedValueOnce(status === "missing" ? { status, missing: "expiry_episode" } : { status });
    const expected = status === "active_mutation_owner" ? { status: "in_progress", reason: "active_mutation_owner" } : { status: "needs_operator_action", reason: "restoration_state_conflict" };
    await expect(coordinate(dependencies)).resolves.toEqual(expected); expect(attempts.completeAuthenticated).not.toHaveBeenCalled();
  });
  it("completes after acquisition even when the caller cancels", async () => {
    const controller = new AbortController(); const { attempts, dependencies } = setup(); attempts.acquireLease.mockImplementationOnce(async () => { controller.abort(); return { status: "lease_acquired", owner, record: owned() }; });
    await expect(coordinate(dependencies, { signal: controller.signal })).resolves.toEqual({ status: "authenticated", source: "observed" }); expect(attempts.completeAuthenticated).toHaveBeenCalledTimes(1);
  });
  it("declares only the narrow repository operation surface", () => {
    const { attempts } = setup(); expect(Object.keys(attempts).sort()).toEqual(["acquireLease", "completeAuthenticated", "findExact", "getOrCreate", "reconcileExpiredLease"]);
  });
});
