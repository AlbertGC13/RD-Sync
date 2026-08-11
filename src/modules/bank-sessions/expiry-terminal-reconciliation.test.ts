import { describe, expect, it, vi } from "vitest";

import { InMemoryBankSessionExpiryEpisodeRepository } from "./expiry-episodes";
import { classifyExpiryTerminalObservation, reconcileExpiryTerminalObservation } from "./expiry-terminal-reconciliation";

const envelope = { bankCode: "popular", expiredEventId: "event-1", runId: "run-1", token: "publication-token" };

async function published(episodes: InMemoryBankSessionExpiryEpisodeRepository, consumerState: "reserved" | "mutation_started" | "manual_recovery_required" | "resolved" | null = null) {
  await episodes.getOrCreate(envelope); await episodes.claimPublication(envelope, envelope.token); await episodes.markPublicationPublished(envelope, envelope.token);
  if (consumerState) {
    await episodes.claimConsumerAttempt(envelope, "consumer-token");
    if (consumerState !== "reserved") await episodes.markConsumerMutationStarted(envelope, "consumer-token");
    if (consumerState === "manual_recovery_required" || consumerState === "resolved") await episodes.markConsumerManualRecoveryRequired(envelope, "consumer-token");
    if (consumerState === "resolved") await episodes.resolveConsumerManualRecovery(envelope, "consumer-token", { operatorId: "admin", decision: { outcome: "resolved_no_retry", reason: "closed_without_retry" } });
  }
}

describe("expiry terminal reconciliation", () => {
  it.each(["waiting", "active", "delayed", "prioritized", "waiting-children", "completed"])("preserves non-terminal %s observations", (state) => {
    expect(classifyExpiryTerminalObservation(state)).toEqual({ kind: "non_terminal", state });
  });

  it("classifies terminal, missing, and unsafe observations without raw errors", async () => {
    expect(classifyExpiryTerminalObservation("failed")).toEqual({ kind: "terminal", reason: "job_failed" });
    expect(classifyExpiryTerminalObservation("missing")).toEqual({ kind: "terminal", reason: "job_missing" });
    expect(classifyExpiryTerminalObservation("unknown")).toEqual({ kind: "observation_rejected", operatorSignal: "Expiry recovery status could not be verified", retryable: true });
    expect(classifyExpiryTerminalObservation(undefined)).toEqual({ kind: "observation_rejected", operatorSignal: "Expiry recovery status could not be verified", retryable: true });
    const repository = { reconcileTerminalFailure: vi.fn() };
    await expect(reconcileExpiryTerminalObservation(async () => { throw new Error("queue password=secret"); }, repository, envelope)).resolves.toEqual({ kind: "observation_rejected", operatorSignal: "Expiry recovery status could not be verified", retryable: true });
    expect(repository.reconcileTerminalFailure).not.toHaveBeenCalled();
  });

  it("calls the repository only for terminal observations", async () => {
    const repository = { reconcileTerminalFailure: vi.fn() };
    await reconcileExpiryTerminalObservation(async () => "waiting", repository, envelope);
    await reconcileExpiryTerminalObservation(async () => "failed", repository, envelope);
    expect(repository.reconcileTerminalFailure).toHaveBeenCalledTimes(1);
    expect(repository.reconcileTerminalFailure.mock.calls[0]?.[1]).toBe("job_failed");
  });

  it("reconciles exactly once, upgrades missing to failed, and projects safe audit data", async () => {
    const episodes = new InMemoryBankSessionExpiryEpisodeRepository(() => new Date("2026-07-28T12:00:00.000Z")); await published(episodes);
    const missing = await reconcileExpiryTerminalObservation(async () => "missing", episodes, envelope);
    const duplicate = await reconcileExpiryTerminalObservation(async () => "missing", episodes, envelope);
    const upgraded = await reconcileExpiryTerminalObservation(async () => "failed", episodes, envelope);
    expect([missing.kind === "terminal" && missing.result.status, duplicate.kind === "terminal" && duplicate.result.status, upgraded.kind === "terminal" && upgraded.result.status]).toEqual(["reconciled", "already_reconciled", "reconciled"]);
    expect(await episodes.findByBankCode("popular")).toMatchObject({ terminalFailureReason: "job_failed" });
    expect(upgraded.kind === "terminal" && upgraded.result.audit).toMatchObject({ actorId: "system", actorRole: "system", action: "bank_autologin.needs_admin_action", target: "bank_session_expiry_episode", targetId: "popular:event-1:run-1", metadata: { bankCode: "popular", expiredEventId: "event-1", runId: "run-1", reconciledAt: expect.any(String), reason: "job_failed" } });
    expect(JSON.stringify(upgraded)).not.toContain("publication-token");
  });

  it("fails closed for stale, restored, pending, and resolved episodes", async () => {
    const episodes = new InMemoryBankSessionExpiryEpisodeRepository(); await published(episodes, "resolved");
    for (const stale of [{ ...envelope, token: "wrong" }, { ...envelope, runId: "other" }]) {
      await expect(episodes.reconcileTerminalFailure(stale, "job_failed", new Date())).resolves.toMatchObject({ status: "ignored_stale_envelope" });
    }
    await expect(episodes.reconcileTerminalFailure(envelope, "job_failed", new Date())).resolves.toMatchObject({ status: "ignored_stale_envelope" });
    const pending = new InMemoryBankSessionExpiryEpisodeRepository(); await pending.getOrCreate(envelope);
    await expect(pending.reconcileTerminalFailure(envelope, "job_failed", new Date())).resolves.toMatchObject({ status: "ignored_stale_envelope" });
    const restored = new InMemoryBankSessionExpiryEpisodeRepository(); await published(restored);
    await restored.markAuditDelivered(envelope, "restored");
    await expect(restored.reconcileTerminalFailure(envelope, "job_failed", new Date())).resolves.toMatchObject({ status: "ignored_stale_envelope" });

  });
  it("requires manual recovery after mutation and converges concurrent terminal evidence", async () => {
    const episodes = new InMemoryBankSessionExpiryEpisodeRepository(); await published(episodes, "mutation_started");
    const results = await Promise.all([episodes.reconcileTerminalFailure(envelope, "job_missing", new Date()), episodes.reconcileTerminalFailure(envelope, "job_failed", new Date())]);
    expect(results.filter((result) => result.status === "reconciled")).toHaveLength(2);
    await expect(episodes.findByBankCode("popular")).resolves.toMatchObject({ consumerAttemptState: "manual_recovery_required", terminalFailureReason: "job_failed" });
  });

  it("defers an active lease without mutation then fail-closes an expired reservation or mutation", async () => {
    let now = new Date("2026-07-28T12:00:00.000Z");
    const episodes = new InMemoryBankSessionExpiryEpisodeRepository(() => now);
    await published(episodes);
    await episodes.claimConsumerAttemptLease({ source: "scheduled", envelope, consumerClaimToken: "owner", leaseDurationMs: 100 });
    await expect(episodes.reconcileTerminalFailure(envelope, "job_failed", now)).resolves.toMatchObject({ status: "deferred_active_lease" });
    await expect(episodes.findByBankCode(envelope.bankCode)).resolves.toMatchObject({ terminalFailureReason: null, consumerAttemptState: "reserved" });
    now = new Date(now.getTime() + 100);
    await expect(episodes.reconcileTerminalFailure(envelope, "job_missing", now)).resolves.toMatchObject({ status: "reconciled" });
    await expect(episodes.findByBankCode(envelope.bankCode)).resolves.toMatchObject({ consumerAttemptState: "manual_recovery_required", consumerLeaseExpiresAt: null, terminalFailureReason: "job_missing" });
    await expect(episodes.reconcileTerminalFailure(envelope, "job_failed", now)).resolves.toMatchObject({ status: "reconciled" });
  });
});
