import { describe, expect, it, vi } from "vitest";

import { createIngestionWorkerShutdown } from "./ingestion-worker-shutdown";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  return { promise: new Promise<void>((done) => { resolve = done; }), resolve };
}

function controls(drain = Promise.resolve()): { calls: string[]; control: Parameters<typeof createIngestionWorkerShutdown>[0]["worker"] } {
  const calls: string[] = [];
  return { calls, control: {
    pauseIntake: vi.fn(async () => { calls.push("pause"); }),
    abortActive: vi.fn(() => { calls.push("abort"); }),
    awaitActiveDrain: vi.fn(() => drain),
    gracefulClose: vi.fn(async () => { calls.push("close:false"); }),
    forceClose: vi.fn(async () => { calls.push("close:true"); }),
  } };
}

describe("createIngestionWorkerShutdown", () => {
  it("orders a graceful shutdown and returns exit code zero", async () => {
    const { calls, control } = controls();
    const shutdown = createIngestionWorkerShutdown({ worker: control, timeoutMs: 10, hooks: {
      stopExpiryScheduling: async () => { calls.push("stop"); }, closeLock: async () => { calls.push("lock"); }, closeExpiryOutbox: async () => { calls.push("expiry"); }, closePrisma: async () => { calls.push("prisma"); },
    } });

    await expect(shutdown()).resolves.toEqual({ exitCode: 0, forced: false, failed: false });
    expect(calls).toEqual(["pause", "abort", "stop", "close:false", "lock", "expiry", "prisma"]);
  });

  it("times out with force as the first and only close, aborting twice and clearing its timer", async () => {
    vi.useFakeTimers();
    const drain = deferred();
    const { calls, control } = controls(drain.promise);
    const shutdown = createIngestionWorkerShutdown({ worker: control, timeoutMs: 10 });
    const result = shutdown();
    await vi.advanceTimersByTimeAsync(10);

    await expect(result).resolves.toEqual({ exitCode: 1, forced: true, failed: false });
    expect(calls).toEqual(["pause", "abort", "abort", "close:true"]);
    expect(control.abortActive).toHaveBeenCalledTimes(2);
    drain.resolve();
    vi.useRealTimers();
  });

  it("forces cleanup after pause or resource failures, attempts every hook, and shares one promise", async () => {
    const { calls, control } = controls();
    control.pauseIntake = vi.fn(async () => { calls.push("pause"); throw new Error("redis://secret"); });
    control.forceClose = vi.fn(async () => { calls.push("close:true"); throw new Error("queue diagnostic"); });
    const shutdown = createIngestionWorkerShutdown({ worker: control, timeoutMs: 10, hooks: {
      stopExpiryScheduling: async () => { calls.push("stop"); throw new Error("x"); }, closeLock: async () => { calls.push("lock"); throw new Error("x"); }, closeExpiryOutbox: async () => { calls.push("expiry"); throw new Error("x"); }, closePrisma: async () => { calls.push("prisma"); throw new Error("x"); },
    } });

    expect(shutdown()).toBe(shutdown());
    await expect(shutdown()).resolves.toEqual({ exitCode: 1, forced: true, failed: true });
    expect(calls).toEqual(["pause", "abort", "stop", "abort", "close:true", "lock", "expiry", "prisma"]);
  });

  it("rejects non-positive timeouts", () => {
    const { control } = controls();
    expect(() => createIngestionWorkerShutdown({ worker: control, timeoutMs: 0 })).toThrow("positive");
  });
});
