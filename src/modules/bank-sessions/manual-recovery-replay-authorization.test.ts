import { describe, expect, it } from "vitest";

import type { ManualRecoveryResolutionDecision } from "./manual-recovery-resolution";
import { InMemoryBankSessionExpiryEpisodeRepository } from "./expiry-episodes";
import { createManualRecoveryReplayAuthorization } from "./manual-recovery-replay-authorization";

const now = new Date("2026-07-28T12:00:00.000Z");
const retryDecision = { outcome: "safe_to_retry", reason: "verified_no_mutation" } as const;

async function resolvedRepository(options: { delivered?: boolean; current?: "original" | "absent" | "pending" | "newer"; decision?: ManualRecoveryResolutionDecision } = {}) {
  const repository = new InMemoryBankSessionExpiryEpisodeRepository(() => now);
  const episode = { bankCode: "popular", expiredEventId: "event-original", runId: "popular-expiry-event-original", token: "publication-token" };
  await repository.getOrCreate(episode); await repository.claimPublication(episode, episode.token); await repository.markPublicationPublished(episode, episode.token);
  await repository.claimConsumerAttempt(episode, episode.token); await repository.markConsumerMutationStarted(episode, episode.token); await repository.markConsumerManualRecoveryRequired(episode, episode.token);
  const resolution = await repository.resolveConsumerManualRecovery(episode, episode.token, { operatorId: "admin-1", decision: options.decision ?? retryDecision });
  if (!resolution) throw new Error("resolution setup failed");
  if (options.current === "absent") await repository.close(episode);
  if (options.current === "pending" || options.current === "newer") { await repository.close(episode); await repository.getOrCreate({ ...episode, expiredEventId: options.current === "pending" ? episode.expiredEventId : "event-newer", runId: options.current === "pending" ? episode.runId : "popular-expiry-event-newer" }); }
  if (options.delivered ?? true) await repository.setManualRecoveryResolutionAuditState(resolution.id, "delivered");
  return { repository, episode, resolution };
}

function authorization(repository: InMemoryBankSessionExpiryEpisodeRepository, ids = ["event-replay", "popular-expiry-event-replay"]) {
  return createManualRecoveryReplayAuthorization({ repository, createExpiredEventId: () => ids[0], createRunId: () => ids[1], clock: () => now });
}

describe("Manual recovery replay authorization", () => {
  it.each(["original", "absent"] as const)("authorizes replay by %s the original episode", async (current) => {
    const { repository, resolution } = await resolvedRepository({ current });
    const result = await authorization(repository).authorize(resolution.id);
    expect(result).toMatchObject({ status: "authorized", replayExpiredEventId: "event-replay", replayRunId: "popular-expiry-event-replay" });
    await expect(repository.findByBankCode("popular")).resolves.toMatchObject({ expiredEventId: "event-replay", publicationState: "pending", publicationClaimToken: null, consumerAttemptState: null });
  });

  it.each([
    ["pending audit", {}, "pending"], ["delivering audit", {}, "delivering"], ["non-retry decision", { decision: { outcome: "resolved_no_retry", reason: "closed_without_retry" } }, "delivered"], ["mutation decision", { decision: { outcome: "mutation_confirmed", reason: "verified_mutation" } }, "delivered"], ["newer episode", { current: "newer" }, "delivered"], ["wrong original state", { current: "pending" }, "delivered"],
  ] as const)("returns ineligible for %s", async (_name, options, state) => {
    const { repository, resolution } = await resolvedRepository({ ...options, delivered: false });
    await repository.setManualRecoveryResolutionAuditState(resolution.id, state);
    await expect(authorization(repository).authorize(resolution.id)).resolves.toEqual({ status: "ineligible" });
  });

  it("rejects invalid or conflicting IDs without effects, then returns the durable replay on retries", async () => {
    const { repository, resolution, episode } = await resolvedRepository();
    for (const ids of [["", "run"], ["same", "same"], [episode.expiredEventId, "new-run"]]) await expect(authorization(repository, ids).authorize(resolution.id)).rejects.toThrow();
    await expect(repository.findByBankCode("popular")).resolves.toMatchObject(episode);
    const first = await authorization(repository).authorize(resolution.id); const retry = await authorization(repository, ["other", "other-run"]).authorize(resolution.id);
    expect(retry).toMatchObject({ status: "already_authorized", replayExpiredEventId: first.replayExpiredEventId, replayRunId: first.replayRunId });
  });

  it("allows one concurrent authorization and exposes an exact token-free audit projection", async () => {
    const { repository, resolution } = await resolvedRepository();
    const [first, second] = await Promise.all([authorization(repository).authorize(resolution.id), authorization(repository).authorize(resolution.id)]);
    expect([first.status, second.status].sort()).toEqual(["already_authorized", "authorized"]);
    expect(first.audit ?? second.audit).toEqual({ id: `bank-autologin-replay-authorized:${resolution.id}`, actorId: "admin-1", actorRole: "admin", action: "bank_autologin.replay_authorized", target: "manual_recovery_resolution", targetId: resolution.id, metadata: { replayExpiredEventId: "event-replay", replayRunId: "popular-expiry-event-replay" }, createdAt: now });
  });
});
