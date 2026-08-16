/**
 * Real PostgreSQL two-replica runtime proof.
 *
 * This suite is skipped unless a dedicated PostgreSQL test-service URL is supplied:
 *
 *   RD_SYNC_REQUIRE_INTEGRATION=true RD_SYNC_TEST_DATABASE_URL="postgresql://..." pnpm test -- src/worker/expiry-runtime.integration.test.ts
 *
 * It uses UUID database rows only. Do not point the variable at development or production infrastructure.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import type { PrismaClient, Prisma } from "../generated/prisma/client";
import type { AuditSink } from "../modules/audit";
import { createBankSessionMonitor } from "../modules/bank-sessions";
import { PrismaManualRecoveryResolutionAuditOutboxRepository } from "../modules/persistence/prisma-manual-recovery-resolution-audit-outbox-repository";
import { createExpiryRuntime, type ExpiryRuntime } from "./expiry-runtime";

const TEST_DATABASE_URL = process.env.RD_SYNC_TEST_DATABASE_URL;
const RUN_INTEGRATION = Boolean(TEST_DATABASE_URL);
const REQUIRE_INTEGRATION = process.env.RD_SYNC_REQUIRE_INTEGRATION === "true";
if (REQUIRE_INTEGRATION && !RUN_INTEGRATION) {
  throw new Error("RD_SYNC_REQUIRE_INTEGRATION=true requires RD_SYNC_TEST_DATABASE_URL");
}
const bankCode = `runtime-${randomUUID()}`;
const manualExpiredEventId = `manual-${randomUUID()}`;
const manualResolutionId = `resolution-${randomUUID()}`;
const manualOutboxId = `outbox-${randomUUID()}`;
const manualRunId = `manual-${randomUUID()}`;
const manualAuditWhere = { action: "bank_autologin.manual_recovery_resolved", target: "manual_recovery_resolution", AND: [{ metadata: { path: ["expiredEventId"], equals: manualExpiredEventId } }, { metadata: { path: ["runId"], equals: manualRunId } }] } satisfies Prisma.AuditEventWhereInput;
let prisma: PrismaClient | undefined;

describe.skipIf(!RUN_INTEGRATION)("expiry runtime integration (requires dedicated PostgreSQL)", () => {
  beforeAll(async () => {
    const prismaModule = await import("../generated/prisma/client");
    prisma = new prismaModule.PrismaClient({
      adapter: new PrismaPg({ connectionString: TEST_DATABASE_URL! }),
    });
  });

  afterEach(async () => {
    await prisma?.auditEvent.deleteMany({ where: manualAuditWhere });
    await prisma?.manualRecoveryResolutionAuditOutbox.deleteMany({ where: { id: manualOutboxId } });
    await prisma?.manualRecoveryResolution.deleteMany({ where: { id: manualResolutionId } });
    await prisma?.bankSessionExpiryEpisode.deleteMany({ where: { bankCode } });
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it("elects one manual-recovery audit delivery without publication ownership across two replicas", async () => {
    if (!prisma) throw new Error("Dedicated PostgreSQL service is required");
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
    const monitorAudits: string[] = [];
    const timers: number[] = [];
    const clearedTimers: number[] = [];
    const ownersSeen = new Set<string>();
    const alerts: Array<{ status: string; safeSummary: string; checkedAt: string }> = [];
    const runtimeTickGate: { wait?: Promise<void>; release?: () => void; signalReplicaATick?: () => void } = {};
    const runtimeTickStats = new Map<string, { calls: number; active: number; max: number }>();
    let releaseClaimBarrier!: () => void;
    const claimBarrier = new Promise<void>((resolve) => { releaseClaimBarrier = resolve; });

    const closeCounts = new Map<string, number>();

    function replica(owner: string): ExpiryRuntime {
      const stats = { calls: 0, active: 0, max: 0 };
      runtimeTickStats.set(owner, stats);
      const monitor = createBankSessionMonitor({
        check: async () => {
          return { status: "expired", checkedAt: new Date().toISOString(), safeSummary: "Synthetic expiry" };
        },
        intervalMs: 60_000,
        alertSink: { notifySessionAttention: async (alert) => { alerts.push(alert); } },
        auditSink: { record: async (event) => { monitorAudits.push(event.action); } },
        monitorMode: { mode: "alert_only" },
      });
      const runtimeMonitor = {
        async tick() {
          stats.calls += 1;
          stats.active += 1;
          stats.max = Math.max(stats.max, stats.active);
          try {
            if (owner === "replica-a") runtimeTickGate.signalReplicaATick?.();
            await runtimeTickGate.wait;
            return await monitor.tick();
          } finally {
            stats.active -= 1;
          }
        },
      };
      return createExpiryRuntime(
        {
          RD_SYNC_SESSION_MONITOR: "enabled",
          DATABASE_URL: TEST_DATABASE_URL,
        },
        () => ({
          monitor: runtimeMonitor,
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
            closeCounts.set(owner, (closeCounts.get(owner) ?? 0) + 1);
          },
        }),
      );
    }

    const runtimeA = replica("replica-a");
    const runtimeB = replica("replica-b");
    runtimeA.start();
    runtimeB.start();
    expect(timers).toEqual([1, 2]);

    await Promise.all([runtimeA.tick(), runtimeB.tick()]);
    expect(await prisma.bankSessionExpiryEpisode.count({ where: { bankCode } })).toBe(0);
    expect(monitorAudits).toEqual(["bank_session.expired", "bank_session.expired"]);
    expect(alerts).toHaveLength(2);
    for (const alert of alerts) {
      expect(alert).toEqual(expect.objectContaining({ status: "expired", safeSummary: "Synthetic expiry" }));
      expect(alert.checkedAt).toEqual(expect.any(String));
      expect(Number.isNaN(Date.parse(alert.checkedAt))).toBe(false);
    }

    await prisma.manualRecoveryResolution.create({
      data: {
        id: manualResolutionId,
        expiredEventId: manualExpiredEventId,
        bankCode,
        runId: manualRunId,
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
    expect(await prisma.auditEvent.count({ where: manualAuditWhere })).toBe(1);
    await prisma.auditEvent.create({
      data: {
        id: `semantic-duplicate-${randomUUID()}`,
        action: "bank_autologin.manual_recovery_resolved",
        target: "manual_recovery_resolution",
        targetId: `duplicate-${manualResolutionId}`,
        metadata: { bankCode, expiredEventId: manualExpiredEventId, runId: manualRunId },
      },
    });
    expect(await prisma.auditEvent.count({ where: manualAuditWhere })).toBe(2);
    runtimeTickGate.wait = new Promise<void>((resolve) => { runtimeTickGate.release = resolve; });
    const replicaATickEntered = new Promise<void>((resolve) => { runtimeTickGate.signalReplicaATick = resolve; });
    const replicaAStats = runtimeTickStats.get("replica-a")!;
    const callsBeforeFinalTick = replicaAStats.calls;
    const firstTick = runtimeA.tick();
    void runtimeA.tick();
    const finalTick = runtimeB.tick();
    await replicaATickEntered;
    expect(replicaAStats.calls).toBe(callsBeforeFinalTick + 1);
    expect(replicaAStats.max).toBe(1);
    const stoppingA = runtimeA.shutdown();
    const stoppingB = runtimeB.shutdown();
    let shutdownAComplete = false;
    void stoppingA.then(() => { shutdownAComplete = true; });
    await Promise.resolve();
    expect(shutdownAComplete).toBe(false);
    expect(new Set(clearedTimers)).toEqual(new Set([1, 2]));
    runtimeTickGate.release?.();
    await Promise.all([firstTick, finalTick, stoppingA, stoppingB, runtimeA.shutdown(), runtimeB.shutdown()]);
    expect(new Set(clearedTimers)).toEqual(new Set([1, 2]));
    expect(closeCounts.get("replica-a")).toBe(1);
    expect(closeCounts.get("replica-b")).toBe(1);
  });
});
