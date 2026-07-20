import { describe, expect, it, vi } from "vitest";

import { InMemoryAuditSink, type AuditSink } from "../audit";
import {
  InMemoryBankSessionExpiryEpisodeRepository,
  PUBLICATION_CLAIM_TIMEOUT_MS,
  parseConsumerAttemptState,
  parseEpisodePublicationState,
  publishExpiryEpisode,
  type BankSessionExpiryEpisode,
  type BankSessionExpiryEpisodeRepository,
  type ExpiryPublicationPublisher,
} from "./expiry-episodes";
import { observeExpiryPublicationJob, scheduleExpiryPublicationJob, type ExpiryPublicationEnvelope, type ExpiryPublicationQueue, type ExpiryPublicationSchedulingState } from "./expiry-publication";
import { createBankSessionMonitor, type BankSessionMonitorDeps } from "./index";

function createPublisherStub(overrides: Partial<ExpiryPublicationPublisher> = {}): ExpiryPublicationPublisher {
  return { schedule: async () => undefined, observe: async () => undefined, ...overrides };
}

interface MonitorOptions { episodes: BankSessionExpiryEpisodeRepository; statuses: Array<"expired" | "active">; alerts?: string[]; auditSink?: Pick<AuditSink, "record">; createExpiredEventId: () => string; publish?: (episode: BankSessionExpiryEpisode) => Promise<void>; }
function createMonitor({ episodes, statuses, alerts = [], auditSink = new InMemoryAuditSink(), createExpiredEventId, publish }: MonitorOptions) {
  let index = 0;
  const deps: BankSessionMonitorDeps = {
    check: async () => {
      const status = statuses[index] ?? statuses[statuses.length - 1] ?? "active";
      index += 1;
      return {
        status,
        checkedAt: "2026-07-12T00:00:00.000Z",
        safeSummary: status === "expired" ? "Bank session expired" : "Bank session is active",
      };
    },
    alertSink: { notifySessionAttention: async ({ status }) => { alerts.push(status); } },
    auditSink,
    intervalMs: 1_000,
    monitorMode: {
      mode: "expiry_events",
      bankCode: "popular",
      episodes,
      createExpiredEventId,
      publish,
    },
  };
  return createBankSessionMonitor(deps);
}

function auditIdentities(audit: InMemoryAuditSink) {
  return audit.list().then((events) => events
    .map(({ id, action }) => ({ id, action }))
    .sort((left, right) => left.id.localeCompare(right.id)));
}

describe("Bank session expiry episodes", () => {
  const consumerClaimToken = "consumer-claim";

  function consumerEnvelope(suffix: string) {
    return { bankCode: `consumer-${suffix}`, expiredEventId: `event-${suffix}`, runId: `run-${suffix}`, token: "publication-token" };
  }
  async function createUnclaimedConsumerEnvelope(episodes: InMemoryBankSessionExpiryEpisodeRepository, suffix: string) {
    const envelope = consumerEnvelope(suffix);
    await episodes.getOrCreate(envelope);
    return envelope;
  }

  async function createPublishedConsumerEnvelope(episodes: InMemoryBankSessionExpiryEpisodeRepository, suffix: string) {
    const envelope = await createUnclaimedConsumerEnvelope(episodes, suffix);
    await episodes.claimPublication(envelope, envelope.token);
    await episodes.markPublicationPublished(envelope, envelope.token);
    return envelope;
  }

  async function requireManualRecovery(episodes: InMemoryBankSessionExpiryEpisodeRepository, episode: BankSessionExpiryEpisode) {
    const token = "consumer-token"; await episodes.claimPublication(episode, token); await episodes.markPublicationPublished(episode, token); const envelope = { ...episode, token }; await episodes.claimConsumerAttempt(envelope, token); await episodes.markConsumerMutationStarted(envelope, token); await episodes.markConsumerManualRecoveryRequired(envelope, token); return envelope;
  }

  it("persists the exact winning consumer claim token for a published envelope", async () => {
    const episodes = new InMemoryBankSessionExpiryEpisodeRepository();
    const envelope = await createPublishedConsumerEnvelope(episodes, "winner");

    await expect(episodes.claimConsumerAttempt(envelope, consumerClaimToken)).resolves.toBe(true);
    await expect(episodes.findByBankCode(envelope.bankCode)).resolves.toMatchObject({ consumerClaimToken });
  });
  interface ConsumerClaimLossCase {
    name: string;
    expected: false;
    prepare(episodes: InMemoryBankSessionExpiryEpisodeRepository): Promise<ReturnType<typeof consumerEnvelope>>;
  }

  const consumerClaimLossCases: readonly ConsumerClaimLossCase[] = [
    { name: "the target row is missing", expected: false, prepare: async () => consumerEnvelope("missing") },
    { name: "the bank code differs", expected: false, prepare: async (episodes) => ({ ...await createPublishedConsumerEnvelope(episodes, "bank"), bankCode: "consumer-other-bank" }) },
    { name: "the expired event differs", expected: false, prepare: async (episodes) => ({ ...await createPublishedConsumerEnvelope(episodes, "event"), expiredEventId: "other-event" }) },
    { name: "the run differs", expected: false, prepare: async (episodes) => ({ ...await createPublishedConsumerEnvelope(episodes, "run"), runId: "other-run" }) },
    { name: "the publication token differs", expected: false, prepare: async (episodes) => ({ ...await createPublishedConsumerEnvelope(episodes, "token"), token: "other-token" }) },
    {
      name: "the published row was restored", expected: false, prepare: async (episodes) => {
        const envelope = await createPublishedConsumerEnvelope(episodes, "restored");
        await episodes.markAuditDelivered(envelope, "restored");
        return envelope;
      },
    },
    { name: "the row is pending", expected: false, prepare: async (episodes) => createUnclaimedConsumerEnvelope(episodes, "pending") },
    {
      name: "the row is publishing", expected: false, prepare: async (episodes) => {
        const envelope = await createUnclaimedConsumerEnvelope(episodes, "publishing");
        await episodes.claimPublication(envelope, envelope.token);
        return envelope;
      },
    },
    {
      name: "the row is cancelled", expected: false, prepare: async (episodes) => {
        const envelope = await createUnclaimedConsumerEnvelope(episodes, "cancelled");
        await episodes.claimPublication(envelope, envelope.token);
        await episodes.cancelPublication(envelope);
        return envelope;
      },
    },
    {
      name: "the published row already has a consumer claim", expected: false, prepare: async (episodes) => {
        const envelope = await createPublishedConsumerEnvelope(episodes, "claimed");
        await episodes.claimConsumerAttempt(envelope, "first-claim");
        return envelope;
      },
    },
  ];

  it.each(consumerClaimLossCases)("loses the consumer claim when $name", async ({ expected, prepare }) => {
    const episodes = new InMemoryBankSessionExpiryEpisodeRepository();
    const envelope = await prepare(episodes);

    await expect(episodes.claimConsumerAttempt(envelope, consumerClaimToken)).resolves.toBe(expected);
  });
  it.each([["empty", ""], ["space", " "], ["tab", "\t"], ["newline", "\n"]] as const)("rejects a %s consumer claim token", async (_name, token) => {
    const episodes = new InMemoryBankSessionExpiryEpisodeRepository();
    const envelope = await createUnclaimedConsumerEnvelope(episodes, `invalid-${JSON.stringify(token)}`);

    await expect(episodes.claimConsumerAttempt(envelope, token)).rejects.toThrow("Consumer claim token must be nonblank");
  });
  it("clears the pending candidate and closes a restored episode before publication retry", async () => {
    // Arrange
    const episodes = new InMemoryBankSessionExpiryEpisodeRepository();
    const audit = new InMemoryAuditSink();
    const publish = vi.fn().mockRejectedValueOnce(new Error("queue unavailable"));
    const monitor = createMonitor({
      episodes,
      statuses: ["expired", "active"],
      auditSink: audit,
      createExpiredEventId: () => "event-a",
      publish,
    });

    // Act
    await monitor.tick();
    await monitor.tick();

    // Assert
    expect(publish).toHaveBeenCalledTimes(1);
    expect(await episodes.findByBankCode("popular")).toBeNull();
    expect(await auditIdentities(audit)).toEqual([expect.objectContaining({ action: "bank_session.expired" }), expect.objectContaining({ action: "bank_session.restored" })]);
  });

  it("observes retained and evicted published jobs without scheduling another attempt", async () => {
    const episodes = new InMemoryBankSessionExpiryEpisodeRepository();
    let state: ExpiryPublicationSchedulingState = "waiting";
    let queued: ExpiryPublicationEnvelope | undefined;
    const storedJob = { getState: vi.fn(async () => state) };
    const getJob = vi.fn(async () => queued ? storedJob : undefined);
    const add = vi.fn(async (_name: string, job: ExpiryPublicationEnvelope) => { queued = job; return storedJob; });
    const queue: ExpiryPublicationQueue = { getJob, add };
    const schedule = vi.fn((job: ExpiryPublicationEnvelope) => scheduleExpiryPublicationJob(queue, job));
    const observe = vi.fn((job: ExpiryPublicationEnvelope) => observeExpiryPublicationJob(queue, job.runId));
    const publish = vi.fn(async (episode: BankSessionExpiryEpisode) => {
      await publishExpiryEpisode(episodes, episode, "token-a", { schedule, observe });
    });
    const monitor = createMonitor({ episodes, statuses: ["expired", "expired"], createExpiredEventId: () => "event-reconcile", publish });

    await monitor.tick();
    state = "failed";
    await monitor.tick();
    queued = undefined;
    await monitor.tick();
    await monitor.tick();

    expect(publish).toHaveBeenCalledTimes(4);
    expect(schedule).toHaveBeenCalledOnce();
    expect(observe).toHaveBeenCalledTimes(3);
    expect(add).toHaveBeenCalledOnce();
    expect(getJob).toHaveBeenCalledTimes(4);
    expect(storedJob.getState).toHaveBeenCalledTimes(2);
    await expect(episodes.findByBankCode("popular")).resolves.toMatchObject({ publicationState: "published", publicationClaimToken: "token-a" });
  });

  it("contains a rejecting observe on an already-published episode and retries next cycle without scheduling", async () => {
    const episodes = new InMemoryBankSessionExpiryEpisodeRepository();
    let observeRejectsOnce = true;
    const schedule = vi.fn(async () => undefined);
    const observe = vi.fn(async () => {
      if (observeRejectsOnce) {
        observeRejectsOnce = false;
        throw new Error("queue unavailable");
      }
    });
    const publish = vi.fn(async (episode: BankSessionExpiryEpisode) => {
      await publishExpiryEpisode(episodes, episode, "token-a", { schedule, observe });
    });
    const monitor = createMonitor({ episodes, statuses: ["expired", "expired", "expired"], createExpiredEventId: () => "event-published-retry", publish });

    await monitor.tick();
    await expect(episodes.findByBankCode("popular")).resolves.toMatchObject({ publicationState: "published", publicationClaimToken: "token-a" });
    expect(schedule).toHaveBeenCalledOnce();

    await monitor.tick();
    expect(observe).toHaveBeenCalledOnce();
    await expect(episodes.findByBankCode("popular")).resolves.toMatchObject({ publicationState: "published", publicationClaimToken: "token-a" });

    await monitor.tick();
    expect(observe).toHaveBeenCalledTimes(2);
    expect(schedule).toHaveBeenCalledOnce();
    await expect(episodes.findByBankCode("popular")).resolves.toMatchObject({ publicationState: "published", publicationClaimToken: "token-a" });
  });

  it("settles stale publishing against a retained failed run without starting another attempt", async () => {
    let now = new Date("2026-07-14T00:00:00.000Z");
    const episodes = new InMemoryBankSessionExpiryEpisodeRepository(() => now);
    const episode = { bankCode: "popular", expiredEventId: "event-stale", runId: "popular-expiry-event-stale" };
    const failedJob = { getState: vi.fn().mockResolvedValue("failed" as const) };
    const add = vi.fn();
    const queue: ExpiryPublicationQueue = { getJob: vi.fn().mockResolvedValue(failedJob), add };
    const schedule = vi.fn((job: ExpiryPublicationEnvelope) => scheduleExpiryPublicationJob(queue, job));
    const observe = vi.fn((job: ExpiryPublicationEnvelope) => observeExpiryPublicationJob(queue, job.runId));

    await episodes.getOrCreate(episode);
    await episodes.claimPublication(episode, "token-a");
    now = new Date(now.getTime() + PUBLICATION_CLAIM_TIMEOUT_MS + 1);

    await expect(publishExpiryEpisode(episodes, episode, "token-b", { schedule, observe })).resolves.toBe(true);
    expect(schedule).toHaveBeenCalledOnce();
    expect(observe).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
    expect(failedJob.getState).toHaveBeenCalledOnce();
    await expect(episodes.findByBankCode(episode.bankCode)).resolves.toMatchObject({ publicationState: "published", publicationClaimToken: "token-a" });
  });

  it("rejects malformed publication tuples and blank publication tokens", async () => {
    const episode = { bankCode: "popular", expiredEventId: "event-tuple", runId: "popular-expiry-event-tuple" }; const episodes = new InMemoryBankSessionExpiryEpisodeRepository();
    for (const [state, token, failure] of [["pending", "token", null], ["publishing", " ", null], ["published", "token", new Date()], ["cancelled", null, new Date()]] as const) expect(() => parseEpisodePublicationState(state, token, failure)).toThrow("Invalid publication tuple");
    await episodes.getOrCreate(episode);
    await expect(publishExpiryEpisode(episodes, episode, " ", createPublisherStub())).rejects.toThrow("Publication token must be nonblank");
    await expect(episodes.claimPublication(episode, "\t")).rejects.toThrow("Publication token must be nonblank");
    await episodes.claimPublication(episode, "token-a"); await episodes.cancelPublication(episode);
    await expect(episodes.findByBankCode("popular")).resolves.toMatchObject({ publicationState: "cancelled", publicationClaimToken: null, publicationFailureReportedAt: null });
  });

  it("preserves enqueue and marker errors while reusing token A after acknowledgement loss", async () => {
    const failureReportedAt = new Date("2026-07-13T00:00:00.000Z"); const episodes = new InMemoryBankSessionExpiryEpisodeRepository(() => failureReportedAt); const episode = { bankCode: "popular", expiredEventId: "event-ack-loss", runId: "popular-expiry-event-ack-loss" }; const acceptedPayloads: Array<{ bankCode: string; expiredEventId: string; runId: string; token: string }> = [];
    const enqueueError = new Error("acknowledgement lost"); const markerError = new Error("marker unavailable");
    const publisher = createPublisherStub({ schedule: async (job: ExpiryPublicationEnvelope) => { acceptedPayloads.push(job); throw enqueueError; } });
    await episodes.getOrCreate(episode); vi.spyOn(episodes, "markPublicationFailureReported").mockRejectedValueOnce(markerError);
    let failure: unknown; try { await publishExpiryEpisode(episodes, episode, "token-a", publisher); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(AggregateError); const aggregate = failure as AggregateError;
    expect(aggregate.cause).toBe(enqueueError); expect(aggregate.errors).toEqual([enqueueError, markerError]);
    vi.restoreAllMocks(); await episodes.markPublicationFailureReported(episode, "token-a"); const failed = await episodes.findByBankCode("popular");
    const recovered = await publishExpiryEpisode(episodes, episode, "token-b", createPublisherStub({ schedule: async (job) => { acceptedPayloads.push(job); } }));
    expect(failed).toMatchObject({ publicationState: "publishing", publicationClaimToken: "token-a" });
    expect(failed?.publicationFailureReportedAt).toEqual(failureReportedAt);
    expect(recovered).toBe(true);
    expect(acceptedPayloads).toEqual([{ ...episode, token: "token-a" }, { ...episode, token: "token-a" }]);
    await expect(episodes.findByBankCode("popular")).resolves.toMatchObject({ publicationState: "published", publicationClaimToken: "token-a", publicationFailureReportedAt: null });
  });

  it("fails closed during a two-replica durable-election outage, then elects one recovered winner", async () => {
    const episodes = new InMemoryBankSessionExpiryEpisodeRepository();
    const alerts: string[] = [];
    const audit = new InMemoryAuditSink();
    const originalGetOrCreate = episodes.getOrCreate.bind(episodes);
    let unavailableCalls = 2;
    vi.spyOn(episodes, "getOrCreate").mockImplementation(async (input) => {
      if (unavailableCalls > 0) {
        unavailableCalls -= 1;
        throw new Error("durable repository unavailable");
      }
      return originalGetOrCreate(input);
    });
    const first = createMonitor({ episodes, statuses: ["expired", "expired", "active"], alerts, auditSink: audit, createExpiredEventId: () => "candidate-a" });
    const second = createMonitor({ episodes, statuses: ["expired", "expired", "active"], alerts, auditSink: audit, createExpiredEventId: () => "candidate-b" });

    await Promise.all([first.tick(), second.tick()]);
    expect(alerts).toEqual([]);
    await expect(auditIdentities(audit)).resolves.toEqual([]);
    await expect(episodes.findByBankCode("popular")).resolves.toBeNull();

    await Promise.all([first.tick(), second.tick()]);
    const winner = await episodes.findByBankCode("popular");
    expect(winner).toMatchObject({
      expiredEventId: expect.stringMatching(/^candidate-[ab]$/),
      runId: expect.stringMatching(/^popular-expiry-candidate-[ab]$/),
    });
    expect(alerts).toEqual(["expired"]);

    await Promise.all([first.tick(), second.tick()]);

    expect(alerts).toEqual(["expired", "active"]);
    expect(await auditIdentities(audit)).toEqual([
      { id: `bank-session-bank_session.expired:popular:${winner?.expiredEventId}`, action: "bank_session.expired" },
      { id: `bank-session-bank_session.restored:popular:${winner?.expiredEventId}`, action: "bank_session.restored" },
    ]);
    await expect(episodes.findByBankCode("popular")).resolves.toBeNull();
  });

  it("does not revive an undurable candidate after the session is active", async () => {
    const episodes = new InMemoryBankSessionExpiryEpisodeRepository();
    const audit = new InMemoryAuditSink();
    const alerts: string[] = [];
    const originalGetOrCreate = episodes.getOrCreate.bind(episodes);
    const attemptedCandidates: Array<{ bankCode: string; expiredEventId: string; runId: string }> = [];
    let persistenceAvailable = false;
    vi.spyOn(episodes, "getOrCreate").mockImplementation(async (input) => {
      attemptedCandidates.push(input);
      if (!persistenceAvailable) throw new Error("durable repository unavailable");
      return originalGetOrCreate(input);
    });
    const monitor = createMonitor({ episodes, statuses: ["active", "expired", "active", "active"], alerts, auditSink: audit, createExpiredEventId: () => "event-outage-recovery" });

    await monitor.tick();
    await monitor.tick();
    await monitor.tick();

    expect(attemptedCandidates).toEqual([{ bankCode: "popular", expiredEventId: "event-outage-recovery", runId: "popular-expiry-event-outage-recovery" }]);
    expect(alerts).toEqual([]);
    expect(await auditIdentities(audit)).toEqual([]);
    await expect(episodes.findByBankCode("popular")).resolves.toBeNull();

    persistenceAvailable = true;
    await monitor.tick();

    expect(attemptedCandidates).toEqual([{ bankCode: "popular", expiredEventId: "event-outage-recovery", runId: "popular-expiry-event-outage-recovery" }]);
    expect(alerts).toEqual([]);
    expect(await auditIdentities(audit)).toEqual([]);
    await expect(episodes.findByBankCode("popular")).resolves.toBeNull();
  });

  it("retries a failed expiry audit with its deterministic ID after one independent best-effort winner notification", async () => {
    const episodes = new InMemoryBankSessionExpiryEpisodeRepository();
    const audit = new InMemoryAuditSink();
    let failFirstRecord = true;
    const failingAudit: Pick<AuditSink, "record"> = {
      record: async (event) => {
        if (failFirstRecord) {
          failFirstRecord = false;
          throw new Error("audit unavailable");
        }
        await audit.record(event);
      },
    };
    const alerts: string[] = [];
    const monitor = createMonitor({ episodes, statuses: ["expired", "expired"], alerts, auditSink: failingAudit, createExpiredEventId: () => "event-audit-retry" });

    await monitor.tick();
    await monitor.tick();

    expect(alerts).toEqual(["expired"]);
    expect(await auditIdentities(audit)).toEqual([
      { id: "bank-session-bank_session.expired:popular:event-audit-retry", action: "bank_session.expired" },
    ]);
    await expect(episodes.findByBankCode("popular")).resolves.toMatchObject({
      expiredEventId: "event-audit-retry",
      expiredAuditDelivered: true,
    });
  });

  it("does not restore or close an unacknowledged expiry episode observed after restart", async () => {
    const episodes = new InMemoryBankSessionExpiryEpisodeRepository();
    const episode = (await episodes.getOrCreate({
      bankCode: "popular", expiredEventId: "event-restart-unacknowledged", runId: "popular-expiry-event-restart-unacknowledged",
    })).episode;
    const audit = new InMemoryAuditSink();
    let failExpiryOnce = true;
    const failingAudit: Pick<AuditSink, "record"> = {
      record: async (event) => {
        if (event.action === "bank_session.expired" && failExpiryOnce) {
          failExpiryOnce = false;
          throw new Error("expiry audit unavailable");
        }
        await audit.record(event);
      },
    };
    const alerts: string[] = [];
    const restartedMonitor = createMonitor({ episodes, statuses: ["active", "active"], alerts, auditSink: failingAudit, createExpiredEventId: () => "unused-candidate" });

    await restartedMonitor.tick();
    await expect(episodes.findByBankCode("popular")).resolves.toEqual(episode);
    expect(alerts).toEqual([]);
    expect(await auditIdentities(audit)).toEqual([]);

    await restartedMonitor.tick();
    expect(await auditIdentities(audit)).toEqual([
      { id: "bank-session-bank_session.expired:popular:event-restart-unacknowledged", action: "bank_session.expired" },
      { id: "bank-session-bank_session.restored:popular:event-restart-unacknowledged", action: "bank_session.restored" },
    ]);
    expect(alerts).toEqual(["active"]);
    await expect(episodes.findByBankCode("popular")).resolves.toBeNull();
  });

  it("retries a failed restoration audit before closing or attempting its notification", async () => {
    const episodes = new InMemoryBankSessionExpiryEpisodeRepository();
    const audit = new InMemoryAuditSink();
    let failRestorationOnce = true;
    const failingAudit: Pick<AuditSink, "record"> = {
      record: async (event) => {
        if (event.action === "bank_session.restored" && failRestorationOnce) {
          failRestorationOnce = false;
          throw new Error("restoration audit unavailable");
        }
        await audit.record(event);
      },
    };
    const alerts: string[] = [];
    const monitor = createMonitor({ episodes, statuses: ["expired", "active", "active"], alerts, auditSink: failingAudit, createExpiredEventId: () => "event-restoration-retry" });

    await monitor.tick();
    await monitor.tick();
    await expect(episodes.findByBankCode("popular")).resolves.toMatchObject({
      expiredEventId: "event-restoration-retry",
      expiredAuditDelivered: true,
      restoredAuditDelivered: false,
    });
    expect(alerts).toEqual(["expired"]);

    await monitor.tick();
    expect(await auditIdentities(audit)).toEqual([
      { id: "bank-session-bank_session.expired:popular:event-restoration-retry", action: "bank_session.expired" },
      { id: "bank-session-bank_session.restored:popular:event-restoration-retry", action: "bank_session.restored" },
    ]);
    expect(alerts).toEqual(["expired", "active"]);
    await expect(episodes.findByBankCode("popular")).resolves.toBeNull();
  });

  it("retries a transient close failure before unresolved retention and resolved active alert", async () => {
    const episodes = new InMemoryBankSessionExpiryEpisodeRepository();
    const audit = new InMemoryAuditSink();
    const alerts: string[] = [];
    const monitor = createMonitor({ episodes, statuses: ["expired", "active", "active", "active"], alerts, auditSink: audit, createExpiredEventId: () => "event-close-retry" });

    await monitor.tick();
    const envelope = await requireManualRecovery(episodes, (await episodes.findByBankCode("popular"))!); const close = vi.spyOn(episodes, "close").mockRejectedValueOnce(new Error("close unavailable"));
    await monitor.tick();
    expect(close).toHaveBeenCalledTimes(1);
    expect(alerts).toEqual(["expired"]);
    await expect(episodes.findByBankCode("popular")).resolves.toMatchObject({ consumerClaimToken: "consumer-token", consumerAttemptState: "manual_recovery_required", restoredAuditDelivered: true });
    await monitor.tick();

    expect(close).toHaveBeenCalledTimes(2);
    expect(alerts).toEqual(["expired"]);
    await episodes.markConsumerManualRecoveryResolved(envelope, "consumer-token"); await monitor.tick();
    expect(close).toHaveBeenCalledTimes(3); expect(alerts).toEqual(["expired", "active"]); await expect(episodes.findByBankCode("popular")).resolves.toBeNull();
  });

  it("restores the normal active alert after a resolved close", async () => {
    const episodes = new InMemoryBankSessionExpiryEpisodeRepository();
    const audit = new InMemoryAuditSink();
    const alerts: string[] = [];
    const expiredMonitor = createMonitor({ episodes, statuses: ["expired"], alerts, auditSink: audit, createExpiredEventId: () => "event-restart" });

    await expiredMonitor.tick();
    const envelope = await requireManualRecovery(episodes, (await episodes.findByBankCode("popular"))!);
    await episodes.markConsumerManualRecoveryResolved(envelope, "consumer-token");
    const restartedActiveMonitor = createMonitor({ episodes, statuses: ["active"], alerts, auditSink: audit, createExpiredEventId: () => "unused-candidate" });
    await restartedActiveMonitor.tick();

    expect(alerts).toEqual(["expired", "active"]);
    expect(await auditIdentities(audit)).toEqual([
      { id: "bank-session-bank_session.expired:popular:event-restart", action: "bank_session.expired" },
      { id: "bank-session-bank_session.restored:popular:event-restart", action: "bank_session.restored" },
    ]);
    await expect(episodes.findByBankCode("popular")).resolves.toBeNull();
  });

  it("clears delayed E1 after a stale close and only reconciles E2 on a later active tick", async () => {
    const base = new InMemoryBankSessionExpiryEpisodeRepository();
    const e1 = (await base.getOrCreate({
      bankCode: "popular", expiredEventId: "event-e1", runId: "popular-expiry-event-e1",
    })).episode;
    const e2 = { bankCode: "popular", expiredEventId: "event-e2", runId: "popular-expiry-event-e2" };
    const closeCalls: string[] = [];
    let replaceOnFirstClose = true;
    const delayedReplica: BankSessionExpiryEpisodeRepository = {
      getOrCreate: (input) => base.getOrCreate(input),
      findByBankCode: (bankCode) => base.findByBankCode(bankCode),
      isAuditDelivered: (episode, kind) => base.isAuditDelivered(episode, kind),
      markAuditDelivered: (episode, kind) => base.markAuditDelivered(episode, kind),
      claimPublication: (episode, token) => base.claimPublication(episode, token),
      markPublicationPublished: (episode, token) => base.markPublicationPublished(episode, token),
      cancelPublication: (episode) => base.cancelPublication(episode),
       markPublicationFailureReported: (episode, token) => base.markPublicationFailureReported(episode, token),
       claimConsumerAttempt: (envelope, token) => base.claimConsumerAttempt(envelope, token),
       markConsumerMutationStarted: (envelope, token) => base.markConsumerMutationStarted(envelope, token),
       markConsumerManualRecoveryRequired: (envelope, token) => base.markConsumerManualRecoveryRequired(envelope, token),
       markConsumerManualRecoveryResolved: (envelope, token) => base.markConsumerManualRecoveryResolved(envelope, token),
       close: async (episode) => {
        closeCalls.push(episode.expiredEventId);
        if (replaceOnFirstClose) {
          replaceOnFirstClose = false;
          await base.close(e1);
          await base.getOrCreate(e2);
          return "missing_or_stale";
        }
        return base.close(episode);
      },
    };
    const audit = new InMemoryAuditSink();
    const monitor = createMonitor({ episodes: delayedReplica, statuses: ["active", "active"], auditSink: audit, createExpiredEventId: () => "unused-candidate" });

    await monitor.tick();
    await expect(base.findByBankCode("popular")).resolves.toMatchObject(e2);
    expect(closeCalls).toEqual(["event-e1"]);

    await monitor.tick();
    expect(closeCalls).toEqual(["event-e1", "event-e2"]);
    await expect(base.findByBankCode("popular")).resolves.toBeNull();
  });

  it("does not let an identity-safe repository close a replacement episode", async () => {
    const episodes = new InMemoryBankSessionExpiryEpisodeRepository();
    const original = (await episodes.getOrCreate({
      bankCode: "popular", expiredEventId: "event-1", runId: "popular-expiry-event-1",
    })).episode;

    await expect(episodes.close(original)).resolves.toBe("closed");
    const replacement = (await episodes.getOrCreate({
      bankCode: "popular", expiredEventId: "event-2", runId: "popular-expiry-event-2",
    })).episode;

    await expect(episodes.close(original)).resolves.toBe("missing_or_stale");
    await expect(episodes.close(replacement)).resolves.toBe("closed");
    await expect(episodes.close(replacement)).resolves.toBe("missing_or_stale");
  });

  it("fails closed for invalid consumer recovery tuples", () => {
    expect(() => parseConsumerAttemptState("reserved", null)).toThrow("Invalid consumer attempt tuple");
    expect(() => parseConsumerAttemptState("unknown", "consumer-token")).toThrow("Invalid consumer attempt tuple");
    expect(() => parseConsumerAttemptState(null, "consumer-token")).toThrow("Invalid consumer attempt tuple");
    expect(parseConsumerAttemptState(null, null)).toBeNull();
  });

  it("moves one exact published consumer claim through the canonical recovery states", async () => {
    const episodes = new InMemoryBankSessionExpiryEpisodeRepository();
    const envelope = await createPublishedConsumerEnvelope(episodes, "state-machine");
    await expect(episodes.claimConsumerAttempt(envelope, "consumer-token")).resolves.toBe(true); await expect(episodes.markConsumerMutationStarted(envelope, "consumer-token")).resolves.toBe(true);
    await expect(episodes.markConsumerManualRecoveryRequired(envelope, "consumer-token")).resolves.toBe(true); await expect(episodes.markConsumerManualRecoveryResolved(envelope, "consumer-token")).resolves.toBe(true);
    await expect(episodes.findByBankCode(envelope.bankCode)).resolves.toMatchObject({ consumerClaimToken: "consumer-token", consumerAttemptState: "resolved" });
  });
  it("fails closed for illegal recovery transitions and stale ownership", async () => {
    const episodes = new InMemoryBankSessionExpiryEpisodeRepository();
    const envelope = await createPublishedConsumerEnvelope(episodes, "illegal");
    await episodes.claimConsumerAttempt(envelope, "consumer-token");
    await expect(episodes.markConsumerMutationStarted({ ...envelope, runId: "wrong-run" }, "consumer-token")).resolves.toBe(false); await expect(episodes.markConsumerMutationStarted(envelope, "wrong-token")).resolves.toBe(false);
    await expect(episodes.markConsumerManualRecoveryRequired(envelope, "consumer-token")).resolves.toBe(false);
    await expect(episodes.markConsumerManualRecoveryResolved(envelope, "consumer-token")).resolves.toBe(false);
  });
  it("clears only reserved ownership when restoration wins", async () => {
    const episodes = new InMemoryBankSessionExpiryEpisodeRepository();
    const envelope = await createPublishedConsumerEnvelope(episodes, "reserved-restoration");
    await episodes.claimConsumerAttempt(envelope, "consumer-token");
    await expect(episodes.markAuditDelivered(envelope, "restored")).resolves.toBe(true);
    await expect(episodes.findByBankCode(envelope.bankCode)).resolves.toMatchObject({
      consumerClaimToken: null, consumerAttemptState: null, restoredAuditDelivered: true,
    });
    await expect(episodes.close(envelope)).resolves.toBe("closed");
  });
  it("retains mutation_started and manual_recovery_required evidence until resolution", async () => {
    const episodes = new InMemoryBankSessionExpiryEpisodeRepository();
    const envelope = await createPublishedConsumerEnvelope(episodes, "manual-recovery");
    await episodes.claimConsumerAttempt(envelope, "consumer-token"); await episodes.markConsumerMutationStarted(envelope, "consumer-token");
    await episodes.markAuditDelivered(envelope, "restored");
    await expect(episodes.close(envelope)).resolves.toBe("retained_for_recovery");
    await expect(episodes.markConsumerManualRecoveryRequired(envelope, "consumer-token")).resolves.toBe(true);
    await expect(episodes.close(envelope)).resolves.toBe("retained_for_recovery");
    await expect(episodes.markConsumerMutationStarted(envelope, "consumer-token")).resolves.toBe(false);
    await expect(episodes.markConsumerManualRecoveryResolved(envelope, "wrong-token")).resolves.toBe(false);
    await expect(episodes.markConsumerManualRecoveryResolved(envelope, "consumer-token")).resolves.toBe(true);
    await expect(episodes.findByBankCode(envelope.bankCode)).resolves.toMatchObject({
      consumerClaimToken: "consumer-token", consumerAttemptState: "resolved", restoredAuditDelivered: true,
    });
    await expect(episodes.close(envelope)).resolves.toBe("closed");
  });
  it.each([
    ["bank", (envelope: ReturnType<typeof consumerEnvelope>) => ({ ...envelope, bankCode: "other-bank" })],
    ["event", (envelope: ReturnType<typeof consumerEnvelope>) => ({ ...envelope, expiredEventId: "other-event" })],
    ["run", (envelope: ReturnType<typeof consumerEnvelope>) => ({ ...envelope, runId: "other-run" })],
    ["publication token", (envelope: ReturnType<typeof consumerEnvelope>) => ({ ...envelope, token: "other-token" })],
  ] as const)("fails closed when mutation-start ownership has a wrong %s", async (_name, change) => {
    const episodes = new InMemoryBankSessionExpiryEpisodeRepository();
    const envelope = await createPublishedConsumerEnvelope(episodes, `wrong-${_name}`);
    await episodes.claimConsumerAttempt(envelope, "consumer-token");
    await expect(episodes.markConsumerMutationStarted(change(envelope), "consumer-token")).resolves.toBe(false);
  });
  it.each(["", " ", "\t", "\n"])("rejects blank tokens for every recovery transition", async (token) => {
    const episodes = new InMemoryBankSessionExpiryEpisodeRepository();
    const envelope = await createPublishedConsumerEnvelope(episodes, `blank-transition-${JSON.stringify(token)}`);
    await episodes.claimConsumerAttempt(envelope, "consumer-token");
    await expect(episodes.markConsumerMutationStarted(envelope, token)).rejects.toThrow("Consumer claim token must be nonblank");
    await expect(episodes.markConsumerManualRecoveryRequired(envelope, token)).rejects.toThrow("Consumer claim token must be nonblank");
    await expect(episodes.markConsumerManualRecoveryResolved(envelope, token)).rejects.toThrow("Consumer claim token must be nonblank");
  });
  it("keeps resolved transitions terminal and closes normally", async () => {
    const episodes = new InMemoryBankSessionExpiryEpisodeRepository();
    const envelope = await createPublishedConsumerEnvelope(episodes, "resolved-terminal");
    await episodes.claimConsumerAttempt(envelope, "consumer-token"); await episodes.markConsumerMutationStarted(envelope, "consumer-token");
    await episodes.markConsumerManualRecoveryRequired(envelope, "consumer-token"); await episodes.markConsumerManualRecoveryResolved(envelope, "consumer-token");
    await expect(episodes.markConsumerMutationStarted(envelope, "consumer-token")).resolves.toBe(false);
    await expect(episodes.markConsumerManualRecoveryRequired(envelope, "consumer-token")).resolves.toBe(false);
    await expect(episodes.markConsumerManualRecoveryResolved(envelope, "consumer-token")).resolves.toBe(false);
    await expect(episodes.close(envelope)).resolves.toBe("closed");
  });
});
