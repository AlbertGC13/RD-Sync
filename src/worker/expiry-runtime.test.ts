import { describe, expect, it, vi } from "vitest";

import type { ExpiryRuntimeDependencies } from "./expiry-runtime";
import { createExpiryRuntime } from "./expiry-runtime";

const enabled = {
  RD_SYNC_SESSION_MONITOR: "enabled",
  DATABASE_URL: "postgres://test",
  RD_SYNC_REDIS_URL: "redis://test",
};
const episode = {
  bankCode: "popular",
  expiredEventId: "event-1",
  runId: "run-1",
  publicationClaimToken: "token",
  publicationState: "published" as const,
};

function dependencies(overrides: Partial<ExpiryRuntimeDependencies> = {}): ExpiryRuntimeDependencies {
  return {
    monitor: { tick: vi.fn().mockResolvedValue(undefined) },
    episodes: {
      findByBankCode: vi.fn().mockResolvedValue(episode),
      reconcileTerminalFailure: vi.fn()
        .mockResolvedValueOnce({ status: "reconciled", operatorSignal: "safe" })
        .mockResolvedValue({ status: "already_reconciled", operatorSignal: "safe" }),
    },
    publisher: { observe: vi.fn().mockResolvedValue("failed") },
    outbox: {
      findClaimable: vi.fn().mockResolvedValue(null),
      claim: vi.fn(),
      markDelivered: vi.fn(),
      releaseClaim: vi.fn(),
      inspect: vi.fn(),
    },
    auditSink: { record: vi.fn(), list: vi.fn() },
    alerts: { notifySessionAttention: vi.fn().mockResolvedValue(undefined) },
    bankCode: "popular",
    leaseOwner: "replica-a",
    ...overrides,
  };
}

describe("expiry runtime", () => {
  it("is default-off without constructing runtime effects", async () => {
    const create = vi.fn();
    const runtime = createExpiryRuntime({}, create);
    runtime.start();
    await runtime.tick();
    await runtime.shutdown();
    expect(runtime.enabled).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it("fails enabled startup before construction when configuration is missing", () => {
    const create = vi.fn();
    expect(() => createExpiryRuntime({ RD_SYNC_SESSION_MONITOR: "enabled" }, create))
      .toThrow("DATABASE_URL");
    expect(create).not.toHaveBeenCalled();
  });

  it("leaves unavailable checks without an episode unobserved", async () => {
    const deps = dependencies({
      episodes: {
        findByBankCode: vi.fn().mockResolvedValue(null),
        reconcileTerminalFailure: vi.fn(),
      },
    });
    await createExpiryRuntime(enabled, () => deps).tick();
    expect(deps.publisher.observe).not.toHaveBeenCalled();
    expect(deps.episodes.reconcileTerminalFailure).not.toHaveBeenCalled();
  });

  it("observes terminal publication once and sends only the fixed safe winner alert", async () => {
    const notifySessionAttention = vi.fn().mockResolvedValue(undefined);
    const deps = dependencies({ alerts: { notifySessionAttention } });
    const runtime = createExpiryRuntime(enabled, () => deps);
    await runtime.tick();
    await runtime.tick();
    expect(deps.publisher.observe).toHaveBeenCalledTimes(2);
    expect(deps.episodes.reconcileTerminalFailure).toHaveBeenCalledTimes(2);
    expect(deps.alerts.notifySessionAttention).toHaveBeenCalledOnce();
    expect(deps.alerts.notifySessionAttention).toHaveBeenCalledWith({
      status: "expired",
      safeSummary: "Automatic session recovery requires administrative review",
      checkedAt: expect.any(String),
    });
    expect(JSON.stringify(notifySessionAttention.mock.calls)).not.toContain("token");
  });

  it("rejects unsafe observations without durable terminal state or alerts", async () => {
    const deps = dependencies({
      publisher: { observe: vi.fn().mockRejectedValue(new Error("redis://secret")) },
    });
    await createExpiryRuntime(enabled, () => deps).tick();
    expect(deps.episodes.reconcileTerminalFailure).not.toHaveBeenCalled();
    expect(deps.alerts.notifySessionAttention).not.toHaveBeenCalled();
  });

  it("drains one leased audit delivery and lets the repository elect replicas", async () => {
    const outbox = {
      findClaimable: vi.fn()
        .mockResolvedValueOnce({
          id: "outbox",
          resolution: {
            id: "resolution",
            bankCode: "popular",
            expiredEventId: "event",
            runId: "run",
            outcome: "resolved_no_retry" as const,
            reason: "closed_without_retry" as const,
            operatorId: "admin",
            resolvedAt: new Date(),
          },
        })
        .mockResolvedValue(null),
      claim: vi.fn().mockResolvedValue(true),
      markDelivered: vi.fn().mockResolvedValue(true),
      releaseClaim: vi.fn(),
      inspect: vi.fn(),
    };
    const deps = dependencies({ outbox });
    await createExpiryRuntime(enabled, () => deps).tick();
    expect(outbox.claim).toHaveBeenCalledWith("outbox", "replica-a", 30_000);
    expect(outbox.markDelivered).toHaveBeenCalledOnce();
  });

  it("limits manual recovery audit deliveries per tick", async () => {
    const outbox = {
      findClaimable: vi.fn().mockResolvedValue({ id: "outbox", resolution: { id: "resolution", bankCode: "popular", expiredEventId: "event", runId: "run", outcome: "resolved_no_retry" as const, reason: "closed_without_retry" as const, operatorId: "admin", resolvedAt: new Date() } }),
      claim: vi.fn().mockResolvedValue(true), markDelivered: vi.fn().mockResolvedValue(true), releaseClaim: vi.fn(), inspect: vi.fn(),
    };
    await createExpiryRuntime(enabled, () => dependencies({ outbox })).tick();
    expect(outbox.markDelivered).toHaveBeenCalledTimes(100);
  });

  it("shares in-flight ticks and closes owned resources exactly once on shutdown", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const close = vi.fn().mockResolvedValue(undefined);
    const deps = dependencies({ monitor: { tick: vi.fn().mockReturnValue(pending) }, close });
    const runtime = createExpiryRuntime(enabled, () => deps);
    const first = runtime.tick();
    const second = runtime.tick();
    const stopping = runtime.shutdown();
    release();
    await Promise.all([first, second, stopping, runtime.shutdown()]);
    expect(deps.monitor.tick).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("waits for a failing in-flight tick but fulfills shutdown", async () => {
    let reject!: (reason: Error) => void;
    const failure = new Error("monitor failed");
    const pending = new Promise<void>((_, rejectPending) => { reject = rejectPending; });
    const close = vi.fn().mockResolvedValue(undefined);
    const runtime = createExpiryRuntime(enabled, () => dependencies({ monitor: { tick: vi.fn().mockReturnValue(pending) }, close }));
    const tick = runtime.tick();
    const stopping = runtime.shutdown();
    reject(failure);
    await expect(tick).rejects.toBe(failure);
    await expect(stopping).resolves.toBeUndefined();
    await expect(runtime.shutdown()).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledOnce();
  });
});
