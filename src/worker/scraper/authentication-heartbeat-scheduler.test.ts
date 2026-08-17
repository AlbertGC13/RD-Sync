import { readFileSync } from "node:fs";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { AuthenticationHeartbeatScheduler } from "./authenticated-session-mutation-runner";
import {
  AUTHENTICATION_HEARTBEAT_LIMITS,
  createFixedDelayAuthenticationHeartbeatScheduler,
  resolveAuthenticationHeartbeatConfig,
} from "./authentication-heartbeat-scheduler";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

type Timer = { readonly callback: () => void; readonly delayMs: number; cancelled: boolean };

class ManualTimers {
  readonly timers: Timer[] = [];
  scheduleError: unknown;
  cancelError: unknown;

  schedule = (callback: () => void, delayMs: number): Timer => {
    if (this.scheduleError) throw this.scheduleError;
    const timer = { callback, delayMs, cancelled: false };
    this.timers.push(timer);
    return timer;
  };

  cancel = (timer: Timer): void => {
    timer.cancelled = true;
    if (this.cancelError) throw this.cancelError;
  };

  fire(index: number): void {
    this.timers[index]?.callback();
  }
}

const flush = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

describe("resolveAuthenticationHeartbeatConfig", () => {
  it("uses immutable defaults", () => {
    const config = resolveAuthenticationHeartbeatConfig({});

    expect(config).toEqual({ leaseMs: 60_000, heartbeatMs: 15_000 });
    expect(Object.isFrozen(config)).toBe(true);
    expect(() => { (config as { leaseMs: number }).leaseMs = 1; }).toThrow();
  });

  it("accepts documented inclusive boundaries", () => {
    expect(resolveAuthenticationHeartbeatConfig({
      RD_SYNC_AUTHENTICATION_LEASE_MS: String(AUTHENTICATION_HEARTBEAT_LIMITS.lease.min),
      RD_SYNC_AUTHENTICATION_HEARTBEAT_MS: String(AUTHENTICATION_HEARTBEAT_LIMITS.heartbeat.min),
    })).toEqual({ leaseMs: 30_000, heartbeatMs: 1_000 });
    expect(resolveAuthenticationHeartbeatConfig({
      RD_SYNC_AUTHENTICATION_LEASE_MS: String(AUTHENTICATION_HEARTBEAT_LIMITS.lease.max),
      RD_SYNC_AUTHENTICATION_HEARTBEAT_MS: String(AUTHENTICATION_HEARTBEAT_LIMITS.heartbeat.max),
    })).toEqual({ leaseMs: 900_000, heartbeatMs: 300_000 });
  });

  it.each(["", " 1000", "1000 ", "+1000", "-1000", "1.0", "1e3", "01", "0", "9007199254740992"])("rejects invalid lexical or unsafe heartbeat values without echoing them: %s", (value) => {
    expect(() => resolveAuthenticationHeartbeatConfig({ RD_SYNC_AUTHENTICATION_HEARTBEAT_MS: value })).toThrow("Invalid authentication heartbeat configuration.");
    try { resolveAuthenticationHeartbeatConfig({ RD_SYNC_AUTHENTICATION_HEARTBEAT_MS: value }); } catch (error) { if (value) expect(String(error)).not.toContain(value); }
  });

  it.each(["", " 60000", "60000 ", "+60000", "-60000", "1.0", "1e3", "01", "0", "9007199254740992"])("rejects invalid lexical or unsafe lease values", (value) => {
    expect(() => resolveAuthenticationHeartbeatConfig({ RD_SYNC_AUTHENTICATION_LEASE_MS: value })).toThrow("Invalid authentication heartbeat configuration.");
  });

  it.each([
    ["RD_SYNC_AUTHENTICATION_LEASE_MS", "29999"],
    ["RD_SYNC_AUTHENTICATION_LEASE_MS", "900001"],
    ["RD_SYNC_AUTHENTICATION_HEARTBEAT_MS", "999"],
    ["RD_SYNC_AUTHENTICATION_HEARTBEAT_MS", "300001"],
  ] as const)("rejects out-of-bound values", (name, value) => {
    expect(() => resolveAuthenticationHeartbeatConfig({ [name]: value })).toThrow("Invalid authentication heartbeat configuration.");
  });

  it("rejects heartbeat intervals that cannot renew the lease safely", () => {
    expect(() => resolveAuthenticationHeartbeatConfig({ RD_SYNC_AUTHENTICATION_LEASE_MS: "30000", RD_SYNC_AUTHENTICATION_HEARTBEAT_MS: "30000" })).toThrow("Invalid authentication heartbeat configuration.");
    expect(() => resolveAuthenticationHeartbeatConfig({ RD_SYNC_AUTHENTICATION_LEASE_MS: "30000", RD_SYNC_AUTHENTICATION_HEARTBEAT_MS: "10001" })).toThrow("Invalid authentication heartbeat configuration.");
  });
});

describe("createFixedDelayAuthenticationHeartbeatScheduler", () => {
  it("validates a positive safe delay and satisfies the WU4b scheduler port", () => {
    expect(() => createFixedDelayAuthenticationHeartbeatScheduler({ delayMs: 0 })).toThrow("Authentication heartbeat delay must be a positive safe integer.");
    expect(() => createFixedDelayAuthenticationHeartbeatScheduler({ delayMs: 1.5 })).toThrow("Authentication heartbeat delay must be a positive safe integer.");
    const scheduler: AuthenticationHeartbeatScheduler = createFixedDelayAuthenticationHeartbeatScheduler({ delayMs: 1 });
    expectTypeOf(scheduler).toMatchTypeOf<AuthenticationHeartbeatScheduler>();
  });

  it("runs the first heartbeat only when its scheduled callback fires", async () => {
    const timers = new ManualTimers();
    const calls: string[] = [];
    const handle = createFixedDelayAuthenticationHeartbeatScheduler({ delayMs: 15, schedule: timers.schedule, cancel: timers.cancel }).start(async () => { calls.push("heartbeat"); });

    expect(timers.timers).toHaveLength(1);
    expect(timers.timers[0]?.delayMs).toBe(15);
    expect(calls).toEqual([]);
    timers.fire(0);
    await flush();
    expect(calls).toEqual(["heartbeat"]);
    await handle.stop();
  });

  it("schedules the next fixed delay only after the heartbeat settles", async () => {
    const timers = new ManualTimers();
    const heartbeat = deferred<void>();
    const handle = createFixedDelayAuthenticationHeartbeatScheduler({ delayMs: 15, schedule: timers.schedule, cancel: timers.cancel }).start(() => heartbeat.promise);

    timers.fire(0);
    await flush();
    expect(timers.timers).toHaveLength(1);
    heartbeat.resolve();
    await flush();
    expect(timers.timers).toHaveLength(2);
    expect(timers.timers[1]?.delayMs).toBe(15);
    await handle.stop();
  });

  it("does not overlap heartbeats when a retained callback is invoked twice", async () => {
    const timers = new ManualTimers();
    const heartbeat = deferred<void>();
    let inFlight = 0;
    let maxInFlight = 0;
    const handle = createFixedDelayAuthenticationHeartbeatScheduler({ delayMs: 1, schedule: timers.schedule, cancel: timers.cancel }).start(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await heartbeat.promise;
      inFlight -= 1;
    });

    timers.fire(0);
    timers.fire(0);
    await flush();
    expect(maxInFlight).toBe(1);
    heartbeat.resolve();
    await flush();
    await handle.stop();
  });

  it("cancels before the first tick and makes a late callback inert", async () => {
    const timers = new ManualTimers();
    let calls = 0;
    const handle = createFixedDelayAuthenticationHeartbeatScheduler({ delayMs: 1, schedule: timers.schedule, cancel: timers.cancel }).start(async () => { calls += 1; });

    await handle.stop();
    expect(timers.timers[0]?.cancelled).toBe(true);
    timers.fire(0);
    await flush();
    expect(calls).toBe(0);
  });

  it.each([undefined, null, 0, false, {}] as const)("cancels an initial timer with handle %j exactly once", async (timerHandle) => {
    let callback!: () => void;
    const cancelled: unknown[] = [];
    const scheduler = createFixedDelayAuthenticationHeartbeatScheduler<typeof timerHandle>({
      delayMs: 1,
      schedule: (next) => { callback = next; return timerHandle; },
      cancel: (handle) => { cancelled.push(handle); },
    });
    let calls = 0;
    const handle = scheduler.start(async () => { calls += 1; });

    await handle.stop();
    await handle.stop();
    expect(cancelled).toEqual([timerHandle]);
    callback();
    await flush();
    expect(calls).toBe(0);
  });

  it("waits for an in-flight heartbeat while stopping", async () => {
    const timers = new ManualTimers();
    const heartbeat = deferred<void>();
    const handle = createFixedDelayAuthenticationHeartbeatScheduler({ delayMs: 1, schedule: timers.schedule, cancel: timers.cancel }).start(() => heartbeat.promise);

    timers.fire(0);
    await flush();
    const stopping = handle.stop();
    let settled = false;
    void stopping.finally(() => { settled = true; });
    await flush();
    expect(settled).toBe(false);
    heartbeat.resolve();
    await expect(stopping).resolves.toBeUndefined();
  });

  it("rejects stopping only after an in-flight heartbeat rejects", async () => {
    const timers = new ManualTimers();
    const heartbeat = deferred<void>();
    const failure = new Error("in-flight heartbeat");
    const handle = createFixedDelayAuthenticationHeartbeatScheduler({ delayMs: 1, schedule: timers.schedule, cancel: timers.cancel }).start(() => heartbeat.promise);

    timers.fire(0);
    await flush();
    const stopping = handle.stop();
    heartbeat.reject(failure);
    await expect(stopping).rejects.toBe(failure);
  });

  it("returns the same stop promise", async () => {
    const timers = new ManualTimers();
    const handle = createFixedDelayAuthenticationHeartbeatScheduler({ delayMs: 1, schedule: timers.schedule, cancel: timers.cancel }).start(async () => {});

    expect(handle.stop()).toBe(handle.stop());
    await handle.stop();
  });

  it("retains the original heartbeat failure, does not reschedule, and rejects stop", async () => {
    const timers = new ManualTimers();
    const failure = new Error("heartbeat failed");
    const handle = createFixedDelayAuthenticationHeartbeatScheduler({ delayMs: 1, schedule: timers.schedule, cancel: timers.cancel }).start(async () => { throw failure; });

    timers.fire(0);
    await flush();
    expect(timers.timers).toHaveLength(1);
    await expect(handle.stop()).rejects.toBe(failure);
    await expect(handle.stop()).rejects.toBe(failure);
  });

  it("surfaces initial and later scheduling failures without later callbacks", async () => {
    const initial = new ManualTimers();
    initial.scheduleError = new Error("initial schedule");
    expect(() => createFixedDelayAuthenticationHeartbeatScheduler({ delayMs: 1, schedule: initial.schedule, cancel: initial.cancel }).start(async () => {})).toThrow(initial.scheduleError);

    const later = new ManualTimers();
    const failure = new Error("later schedule");
    const handle = createFixedDelayAuthenticationHeartbeatScheduler({ delayMs: 1, schedule: later.schedule, cancel: later.cancel }).start(async () => { later.scheduleError = failure; });
    later.fire(0);
    await flush();
    await expect(handle.stop()).rejects.toBe(failure);
    expect(later.timers).toHaveLength(1);
  });

  it("rejects stop when cancellation throws and keeps callbacks inert", async () => {
    const timers = new ManualTimers();
    const failure = new Error("cancel");
    let calls = 0;
    const handle = createFixedDelayAuthenticationHeartbeatScheduler({ delayMs: 1, schedule: timers.schedule, cancel: timers.cancel }).start(async () => { calls += 1; });
    timers.cancelError = failure;

    await expect(handle.stop()).rejects.toBe(failure);
    timers.fire(0);
    await flush();
    expect(calls).toBe(0);
  });

  it("creates independent timer state for each start handle", async () => {
    const timers = new ManualTimers();
    const scheduler = createFixedDelayAuthenticationHeartbeatScheduler({ delayMs: 1, schedule: timers.schedule, cancel: timers.cancel });
    let first = 0;
    let second = 0;
    const firstHandle = scheduler.start(async () => { first += 1; });
    scheduler.start(async () => { second += 1; });

    await firstHandle.stop();
    timers.fire(0);
    timers.fire(1);
    await flush();
    expect(first).toBe(0);
    expect(second).toBe(1);
  });

  it("uses no interval scheduler and has no production composition caller", () => {
    const source = readFileSync(new URL("./authentication-heartbeat-scheduler.ts", import.meta.url), "utf8");
    expect(source).not.toContain("setInterval");
    expect(source).not.toContain("process.env");
  });
});
