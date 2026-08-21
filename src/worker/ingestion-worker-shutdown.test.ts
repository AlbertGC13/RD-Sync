import { describe, expect, it, vi } from "vitest";
import { createIngestionWorkerShutdown, installIngestionWorkerShutdown } from "./ingestion-worker-shutdown";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  return { promise: new Promise<void>((done) => { resolve = done; }), resolve };
}

function controls(calls: string[], drain = Promise.resolve()) {
  return {
    pauseIntake: vi.fn(async () => { calls.push("pause"); }),
    abortActive: vi.fn(() => { calls.push("abort"); }),
    awaitActiveDrain: vi.fn(() => drain),
    gracefulClose: vi.fn(async () => { calls.push("close:false"); }),
    forceClose: vi.fn(async () => { calls.push("close:true"); }),
  };
}

describe("createIngestionWorkerShutdown", () => {
  it("finishes graceful work in exact order", async () => {
    const calls: string[] = []; const worker = controls(calls);
    const shutdown = createIngestionWorkerShutdown({ worker, timeoutMs: 10, hooks: { stopExpiryScheduling: () => { calls.push("stop"); }, closeLock: () => { calls.push("lock"); }, closeExpiryOutbox: () => { calls.push("expiry"); }, closePrisma: () => { calls.push("prisma"); } } });
    await expect(shutdown()).resolves.toEqual({ status: "graceful", exitCode: 0 });
    expect(calls).toEqual(["pause", "abort", "stop", "close:false", "lock", "expiry", "prisma"]);
  });

  it.each(["pause", "drain"])("forces as the only close when deadline occurs during %s", async (phase) => {
    vi.useFakeTimers(); const calls: string[] = []; const wait = deferred(); const worker = controls(calls, phase === "drain" ? wait.promise : Promise.resolve());
    if (phase === "pause") worker.pauseIntake = vi.fn(async () => { calls.push("pause"); await wait.promise; });
    const shutdown = createIngestionWorkerShutdown({ worker, timeoutMs: 10, hooks: { closeLock: () => { calls.push("lock"); }, closeExpiryOutbox: () => { calls.push("expiry"); }, closePrisma: () => { calls.push("prisma"); } } });
    const result = shutdown(); await vi.advanceTimersByTimeAsync(10);
    await expect(result).resolves.toEqual({ status: "timed_out", exitCode: 1 });
    expect(calls).toEqual(expect.arrayContaining(["abort", "close:true", "lock", "expiry", "prisma"])); expect(calls).not.toContain("close:false");
    wait.resolve(); vi.useRealTimers();
  });

  it("does not upgrade an already-started graceful close after deadline", async () => {
    vi.useFakeTimers(); const calls: string[] = []; const wait = deferred(); const worker = controls(calls); worker.gracefulClose = vi.fn(async () => { calls.push("close:false"); await wait.promise; });
    const shutdown = createIngestionWorkerShutdown({ worker, timeoutMs: 10, hooks: { closeLock: () => { calls.push("lock"); }, closeExpiryOutbox: () => { calls.push("expiry"); }, closePrisma: () => { calls.push("prisma"); } } });
    const result = shutdown(); await vi.advanceTimersByTimeAsync(10);
    await expect(result).resolves.toEqual({ status: "timed_out", exitCode: 1 }); expect(calls).toEqual(expect.arrayContaining(["close:false", "lock", "expiry", "prisma"])); expect(calls).not.toContain("close:true");
    wait.resolve(); vi.useRealTimers();
  });

  it("continues hooks after close failure or a hanging hook", async () => {
    vi.useFakeTimers(); const calls: string[] = []; const wait = deferred(); const worker = controls(calls); worker.gracefulClose = vi.fn(async () => { calls.push("close:false"); throw new Error("x"); });
    const shutdown = createIngestionWorkerShutdown({ worker, timeoutMs: 10, hooks: { closeLock: async () => { calls.push("lock"); await wait.promise; }, closeExpiryOutbox: () => { calls.push("expiry"); }, closePrisma: () => { calls.push("prisma"); } } });
    const result = shutdown(); await vi.advanceTimersByTimeAsync(10);
    await expect(result).resolves.toEqual({ status: "timed_out", exitCode: 1 }); expect(calls).toEqual(expect.arrayContaining(["close:false", "lock", "expiry", "prisma"])); expect(calls).not.toContain("close:true");
    wait.resolve(); vi.useRealTimers();
  });

  it("returns failed, not forced, when graceful close rejects before deadline", async () => {
    const calls: string[] = []; const worker = controls(calls); worker.gracefulClose = vi.fn(async () => { calls.push("close:false"); throw new Error("x"); });
    const shutdown = createIngestionWorkerShutdown({ worker, timeoutMs: 10, hooks: { closeLock: () => { calls.push("lock"); }, closeExpiryOutbox: () => { calls.push("expiry"); }, closePrisma: () => { calls.push("prisma"); } } });
    await expect(shutdown()).resolves.toEqual({ status: "failed", exitCode: 1 }); expect(calls).toEqual(["pause", "abort", "close:false", "lock", "expiry", "prisma"]);
  });

  it.each(["rejects", "hangs"])("stops expiry once before force when pause %s", async (mode) => {
    vi.useFakeTimers(); const calls: string[] = []; const wait = deferred(); const worker = controls(calls);
    worker.pauseIntake = vi.fn(async () => { calls.push("pause"); if (mode === "rejects") throw new Error("x"); await wait.promise; });
    const shutdown = createIngestionWorkerShutdown({ worker, timeoutMs: 10, hooks: { stopExpiryScheduling: () => { calls.push("stop"); }, closeLock: () => { calls.push("lock"); }, closeExpiryOutbox: () => { calls.push("expiry"); }, closePrisma: () => { calls.push("prisma"); } } });
    const result = shutdown(); if (mode === "hangs") await vi.advanceTimersByTimeAsync(10);
    await expect(result).resolves.toMatchObject({ exitCode: 1 }); expect(calls).toEqual(expect.arrayContaining(["abort", "stop", "close:true", "lock", "expiry", "prisma"])); expect(calls.indexOf("stop")).toBeLessThan(calls.indexOf("close:true")); expect(calls.filter((x) => x === "stop")).toHaveLength(1);
    wait.resolve(); vi.useRealTimers();
  });
});

describe("installIngestionWorkerShutdown", () => {
  it("terminates once for repeated signals after a non-graceful result", async () => {
    const handlers = new Map<string, () => void>(); const terminate = vi.fn(); const shutdown = vi.fn(async () => ({ status: "forced" as const, exitCode: 1 as const }));
    installIngestionWorkerShutdown({ shutdown, terminate, signals: { on: (signal: "SIGTERM" | "SIGINT", handler: () => void) => { handlers.set(signal, handler); } } }); handlers.get("SIGTERM")?.(); handlers.get("SIGINT")?.(); await Promise.resolve(); await Promise.resolve();
    expect(shutdown).toHaveBeenCalledOnce(); expect(terminate).toHaveBeenCalledWith(1);
  });
});
