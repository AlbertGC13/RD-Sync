import { describe, expect, it, vi } from "vitest";

import { InMemoryAuditSink, type AuditSink } from "../audit";
import {
  InMemoryBankSessionExpiryEpisodeRepository,
  type BankSessionExpiryEpisodeRepository,
} from "./expiry-episodes";
import { createBankSessionMonitor, type BankSessionMonitorDeps } from "./index";

function createMonitor(
  episodes: BankSessionExpiryEpisodeRepository,
  statuses: Array<"expired" | "active">,
  alerts: string[],
  auditSink: Pick<AuditSink, "record"> = new InMemoryAuditSink(),
  createExpiredEventId: () => string,
) {
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
    const first = createMonitor(episodes, ["expired", "expired", "active"], alerts, audit, () => "candidate-a");
    const second = createMonitor(episodes, ["expired", "expired", "active"], alerts, audit, () => "candidate-b");

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

  it("retains one local candidate across an outage until active recovery can durably elect and close it", async () => {
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
    const monitor = createMonitor(
      episodes,
      ["active", "expired", "active", "active"],
      alerts,
      audit,
      () => "event-outage-recovery",
    );

    await monitor.tick();
    await monitor.tick();
    await monitor.tick();

    expect(attemptedCandidates).toEqual([
      { bankCode: "popular", expiredEventId: "event-outage-recovery", runId: "popular-expiry-event-outage-recovery" },
      { bankCode: "popular", expiredEventId: "event-outage-recovery", runId: "popular-expiry-event-outage-recovery" },
    ]);
    expect(alerts).toEqual([]);
    expect(await auditIdentities(audit)).toEqual([]);
    await expect(episodes.findByBankCode("popular")).resolves.toBeNull();

    persistenceAvailable = true;
    await monitor.tick();

    expect(attemptedCandidates).toEqual([
      { bankCode: "popular", expiredEventId: "event-outage-recovery", runId: "popular-expiry-event-outage-recovery" },
      { bankCode: "popular", expiredEventId: "event-outage-recovery", runId: "popular-expiry-event-outage-recovery" },
      { bankCode: "popular", expiredEventId: "event-outage-recovery", runId: "popular-expiry-event-outage-recovery" },
    ]);
    expect(alerts).toEqual(["expired", "active"]);
    expect(await auditIdentities(audit)).toEqual([
      { id: "bank-session-bank_session.expired:popular:event-outage-recovery", action: "bank_session.expired" },
      { id: "bank-session-bank_session.restored:popular:event-outage-recovery", action: "bank_session.restored" },
    ]);
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
    const monitor = createMonitor(episodes, ["expired", "expired"], alerts, failingAudit, () => "event-audit-retry");

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
    const restartedMonitor = createMonitor(episodes, ["active", "active"], alerts, failingAudit, () => "unused-candidate");

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
    const monitor = createMonitor(episodes, ["expired", "active", "active"], alerts, failingAudit, () => "event-restoration-retry");

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

  it("retries an active close and lets only the closing winner attempt the best-effort restoration notification", async () => {
    const episodes = new InMemoryBankSessionExpiryEpisodeRepository();
    const audit = new InMemoryAuditSink();
    const alerts: string[] = [];
    vi.spyOn(episodes, "close").mockRejectedValueOnce(new Error("close unavailable"));
    const monitor = createMonitor(episodes, ["expired", "active", "active"], alerts, audit, () => "event-close-retry");

    await monitor.tick();
    await monitor.tick();
    await expect(episodes.findByBankCode("popular")).resolves.toMatchObject({ expiredEventId: "event-close-retry" });
    await monitor.tick();

    expect(alerts).toEqual(["expired", "active"]);
    expect(await auditIdentities(audit)).toEqual([
      { id: "bank-session-bank_session.expired:popular:event-close-retry", action: "bank_session.expired" },
      { id: "bank-session-bank_session.restored:popular:event-close-retry", action: "bank_session.restored" },
    ]);
    await expect(episodes.findByBankCode("popular")).resolves.toBeNull();
  });

  it("lets a restarted active monitor close the durable episode with canonical audits", async () => {
    const episodes = new InMemoryBankSessionExpiryEpisodeRepository();
    const audit = new InMemoryAuditSink();
    const alerts: string[] = [];
    const expiredMonitor = createMonitor(episodes, ["expired"], alerts, audit, () => "event-restart");

    await expiredMonitor.tick();
    const restartedActiveMonitor = createMonitor(episodes, ["active"], alerts, audit, () => "unused-candidate");
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
    const monitor = createMonitor(delayedReplica, ["active", "active"], [], audit, () => "unused-candidate");

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
});
