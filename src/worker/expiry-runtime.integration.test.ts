/**
 * Real PostgreSQL + Redis two-replica runtime proof.
 *
 * This suite is skipped unless BOTH dedicated test-service URLs are supplied:
 *
 *   RD_SYNC_TEST_DATABASE_URL="postgresql://..." RD_SYNC_TEST_REDIS_URL="redis://..." pnpm test -- src/worker/expiry-runtime.integration.test.ts
 *
 * It uses a UUID queue and deletes only its own database rows and Redis queue.
 * Do not point either variable at development or production infrastructure.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import type { PrismaClient, Prisma } from "../generated/prisma/client";
import type { AuditSink } from "../modules/audit";
import { createBankSessionMonitor, createExpiredSessionRunId } from "../modules/bank-sessions";
import { publishExpiryEpisode } from "../modules/bank-sessions/expiry-episodes";
import { PrismaBankSessionExpiryEpisodeRepository } from "../modules/persistence/prisma-bank-session-expiry-episode-repository";
import { PrismaManualRecoveryResolutionAuditOutboxRepository } from "../modules/persistence/prisma-manual-recovery-resolution-audit-outbox-repository";
import { buildRedisConnectionOptions } from "./queues/bullmq-queue";
import { createExpiryRuntime, type ExpiryRuntime } from "./expiry-runtime";
import { observeExpiryPublicationJob, scheduleExpiryPublicationJob } from "../modules/bank-sessions/expiry-publication";

const TEST_DATABASE_URL = process.env.RD_SYNC_TEST_DATABASE_URL;
const TEST_REDIS_URL = process.env.RD_SYNC_TEST_REDIS_URL;
const RUN_INTEGRATION = Boolean(TEST_DATABASE_URL && TEST_REDIS_URL);
const queueName = `expiry-runtime-integration-${randomUUID()}`;
const bankCode = `runtime-${randomUUID()}`;
const expiredEventId = `event-${randomUUID()}`;
const runId = createExpiredSessionRunId(bankCode, expiredEventId);
const publicationToken = `publication-${randomUUID()}`;
const manualExpiredEventId = `manual-${randomUUID()}`;
const manualResolutionId = `resolution-${randomUUID()}`;
const manualOutboxId = `outbox-${randomUUID()}`;
const expiryAuditId = `bank-session-bank_session.expired:${bankCode}:${expiredEventId}`;
const terminalAuditId = `bank-session-expiry-terminal:${bankCode}:${expiredEventId}:${runId}`;
const manualAuditId = `bank-autologin-manual-recovery-resolved:${manualResolutionId}`;
let prisma: PrismaClient | undefined;
let Queue: typeof import("bullmq").Queue;
let Worker: typeof import("bullmq").Worker;
let queueA: import("bullmq").Queue | undefined;
let queueB: import("bullmq").Queue | undefined;
let worker: import("bullmq").Worker | undefined;
const closedQueues = new Set<import("bullmq").Queue>();
const closeCounts = new Map<import("bullmq").Queue, number>();

describe.skipIf(!RUN_INTEGRATION)("expiry runtime integration (requires dedicated PostgreSQL and Redis)", () => {
  beforeAll(async () => {
    const prismaModule = await import("../generated/prisma/client");
    const bullmq = await import("bullmq");
    Queue = bullmq.Queue;
    Worker = bullmq.Worker;
    prisma = new prismaModule.PrismaClient({
      adapter: new PrismaPg({ connectionString: TEST_DATABASE_URL! }),
    });
  });

  afterEach(async () => {
    await worker?.close().catch(() => undefined);
    worker = undefined;
    if (TEST_REDIS_URL) {
      const cleanupQueue = new Queue(queueName, {
        connection: buildRedisConnectionOptions(TEST_REDIS_URL),
      });
      await cleanupQueue.obliterate({ force: true }).catch(() => undefined);
      await cleanupQueue.close().catch(() => undefined);
    }
    await prisma?.auditEvent.deleteMany({
      where: { id: { in: [expiryAuditId, terminalAuditId, manualAuditId] } },
    });
    await prisma?.manualRecoveryResolutionAuditOutbox.deleteMany({ where: { id: manualOutboxId } });
    await prisma?.manualRecoveryResolution.deleteMany({ where: { id: manualResolutionId } });
    await prisma?.bankSessionExpiryEpisode.deleteMany({ where: { bankCode } });
  });

  afterAll(async () => {
    await worker?.close().catch(() => undefined);
    for (const queue of [queueA, queueB]) {
      if (queue && !closedQueues.has(queue)) await queue.close();
    }
    await prisma?.$disconnect();
  });

  it("elects durable owners, terminal reconciliation, delivery, and graceful shutdown across two replicas", async () => {
    if (!prisma || !TEST_REDIS_URL) throw new Error("Dedicated integration services are required");
    const connection = buildRedisConnectionOptions(TEST_REDIS_URL);
    queueA = new Queue(queueName, { connection });
    queueB = new Queue(queueName, { connection });
    const episodes = new PrismaBankSessionExpiryEpisodeRepository(prisma);
    const outbox = new PrismaManualRecoveryResolutionAuditOutboxRepository(prisma);
    const auditSink: AuditSink = {
      async record(event) {
        await prisma!.auditEvent.upsert({
          where: { id: event.id },
          create: { ...event, metadata: (event.metadata as Prisma.InputJsonValue | null) ?? undefined },
          update: {},
        });
      },
      async list() { return []; },
    };
    const timers: number[] = [];
    const clearedTimers: number[] = [];
    const ownersSeen = new Set<string>();
    const alerts: Array<{ safeSummary: string }> = [];
    const tickGate: { wait?: Promise<void>; release?: () => void } = {};
    const localTickStats = new Map<string, { calls: number; active: number; max: number }>();
    let releaseClaimBarrier!: () => void;
    const claimBarrier = new Promise<void>((resolve) => { releaseClaimBarrier = resolve; });

    function replica(owner: string, queue: import("bullmq").Queue): ExpiryRuntime {
      const stats = { calls: 0, active: 0, max: 0 };
      localTickStats.set(owner, stats);
      const publisher = {
        schedule: (envelope: { bankCode: string; expiredEventId: string; runId: string; token: string }) =>
          scheduleExpiryPublicationJob(queue, envelope),
        observe: (envelope: { runId: string }) => observeExpiryPublicationJob(queue, envelope.runId),
      };
      const monitor = createBankSessionMonitor({
        check: async () => {
          stats.calls += 1;
          stats.active += 1;
          stats.max = Math.max(stats.max, stats.active);
          try {
            await tickGate.wait;
            return { status: "expired", checkedAt: new Date().toISOString(), safeSummary: "Synthetic expiry" };
          } finally {
            stats.active -= 1;
          }
        },
        intervalMs: 60_000,
        alertSink: { notifySessionAttention: async (alert) => { alerts.push(alert); } },
        auditSink,
        monitorMode: {
          mode: "expiry_events",
          bankCode,
          episodes,
          createExpiredEventId: () => expiredEventId,
          publish: (episode) => publishExpiryEpisode(episodes, episode, publicationToken, publisher).then(() => undefined),
        },
      });
      return createExpiryRuntime(
        {
          RD_SYNC_SESSION_MONITOR: "enabled",
          DATABASE_URL: TEST_DATABASE_URL,
          RD_SYNC_REDIS_URL: TEST_REDIS_URL,
        },
        () => ({
          monitor,
          episodes,
          publisher,
          auditSink,
          bankCode,
          leaseOwner: owner,
          outbox: {
            findClaimable: async () => {
              const candidate = await outbox.findClaimable();
              if (candidate?.id === manualOutboxId) {
                ownersSeen.add(owner);
                if (ownersSeen.size === 2) releaseClaimBarrier();
                await claimBarrier;
              }
              return candidate;
            },
            claim: (id, leaseOwner, leaseMs) => outbox.claim(id, leaseOwner, leaseMs),
            markDelivered: (id, leaseOwner) => outbox.markDelivered(id, leaseOwner),
            releaseClaim: (id, leaseOwner) => outbox.releaseClaim(id, leaseOwner),
            inspect: (id) => outbox.inspect(id),
          },
          alerts: { notifySessionAttention: async (alert) => { alerts.push(alert); } },
          schedule: () => {
            const timer = timers.length + 1;
            timers.push(timer);
            return timer;
          },
          clearSchedule: (timer) => { clearedTimers.push(timer as number); },
          close: async () => {
            if (closedQueues.has(queue)) return;
            closedQueues.add(queue);
            closeCounts.set(queue, (closeCounts.get(queue) ?? 0) + 1);
            await queue.close();
          },
        }),
      );
    }

    const runtimeA = replica("replica-a", queueA);
    const runtimeB = replica("replica-b", queueB);
    runtimeA.start();
    runtimeB.start();
    expect(queueA).not.toBe(queueB);
    expect(timers).toEqual([1, 2]);

    await Promise.all([runtimeA.tick(), runtimeB.tick()]);
    const episode = await episodes.findByBankCode(bankCode);
    expect(episode).toMatchObject({
      expiredEventId,
      runId,
      publicationState: "published",
      publicationClaimToken: publicationToken,
    });
    expect(await prisma.auditEvent.count({ where: { id: expiryAuditId } })).toBe(1);
    expect(await queueA.getJob(runId)).toBeDefined();

    worker = new Worker(
      queueName,
      async (job) => {
        job.discard();
        throw new Error("synthetic publication failure");
      },
      { connection, concurrency: 1 },
    );
    await new Promise<void>((resolve) => worker!.once("ready", resolve));
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for synthetic terminal failure")), 5_000);
      worker!.on("failed", (job) => {
        if (job?.id === runId) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });
    await expect((await queueA.getJob(runId))?.getState()).resolves.toBe("failed");

    await prisma.manualRecoveryResolution.create({
      data: {
        id: manualResolutionId,
        expiredEventId: manualExpiredEventId,
        bankCode,
        runId: `manual-${runId}`,
        outcome: "resolved_no_retry",
        reason: "closed_without_retry",
        operatorId: "operator-integration",
        auditOutbox: { create: { id: manualOutboxId } },
      },
    });
    await Promise.all([runtimeA.tick(), runtimeB.tick()]);
    expect(ownersSeen).toEqual(new Set(["replica-a", "replica-b"]));
    expect(await prisma.manualRecoveryResolutionAuditOutbox.count({
      where: { id: manualOutboxId, state: "delivered" },
    })).toBe(1);
    expect(await prisma.auditEvent.count({ where: { id: manualAuditId } })).toBe(1);
    expect(await prisma.auditEvent.count({ where: { id: terminalAuditId } })).toBe(1);
    expect(alerts.filter((alert) => alert.safeSummary === "Automatic session recovery requires administrative review")).toHaveLength(1);
    expect(JSON.stringify(alerts)).not.toMatch(/token|https?:\/\/|synthetic publication failure/i);

    tickGate.wait = new Promise<void>((resolve) => { tickGate.release = resolve; });
    const replicaAStats = localTickStats.get("replica-a")!;
    const callsBeforeFinalTick = replicaAStats.calls;
    const firstTick = runtimeA.tick();
    runtimeA.tick();
    const finalTick = runtimeB.tick();
    await Promise.resolve();
    expect(replicaAStats.calls).toBe(callsBeforeFinalTick + 1);
    expect(replicaAStats.max).toBe(1);
    const stoppingA = runtimeA.shutdown();
    const stoppingB = runtimeB.shutdown();
    let shutdownAComplete = false;
    void stoppingA.then(() => { shutdownAComplete = true; });
    await Promise.resolve();
    expect(shutdownAComplete).toBe(false);
    expect(new Set(clearedTimers)).toEqual(new Set([1, 2]));
    tickGate.release?.();
    await Promise.all([firstTick, finalTick, stoppingA, stoppingB, runtimeA.shutdown(), runtimeB.shutdown()]);
    expect(new Set(clearedTimers)).toEqual(new Set([1, 2]));
    expect(closeCounts.get(queueA)).toBe(1);
    expect(closeCounts.get(queueB)).toBe(1);
  });
});
