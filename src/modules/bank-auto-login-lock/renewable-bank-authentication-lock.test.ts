import { describe, expect, it, vi } from "vitest";
import type { LockStore } from "./index";
import { createRenewableBankAuthenticationLock } from "./renewable-bank-authentication-lock";

function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>((done) => { resolve = done; }), resolve }; }
function setup(overrides: Partial<LockStore> = {}) {
  const timers: Array<() => void> = []; const clear = vi.fn(); const calls: string[] = [];
  const store: LockStore = { acquireSlot: vi.fn(async ({ key }) => { calls.push(`acquire:${key}`); return 1; }), renewIfOwner: vi.fn(async ({ key }) => { calls.push(`renew:${key}`); return true; }), releaseIfOwner: vi.fn(async (key) => { calls.push(`release:${key}`); return true; }), ...overrides };
  const lock = createRenewableBankAuthenticationLock({ store, generateLeaseToken: () => "secret", now: () => 7, scheduler: { setInterval: (fn) => { timers.push(fn); return { unref: vi.fn() }; }, clearInterval: clear } });
  return { lock, store, timers, clear, calls };
}

describe("createRenewableBankAuthenticationLock", () => {
  it("serializes a bank, keeps banks independent, and exposes no authority details", async () => {
    const held = new Set<string>(); const { lock } = setup({ acquireSlot: async ({ key }) => held.has(key) ? null : (held.add(key), 1) });
    const popular = await lock.acquire({ bankCode: "popular" });
    expect([await lock.acquire({ bankCode: "popular" }), await lock.acquire({ bankCode: "banreservas" }), Object.keys(popular!)]).toEqual([null, expect.anything(), ["signal", "release"]]);
  });
  it("schedules serialized renewal and loses authority on false or throw", async () => {
    for (const result of [false, "throw"] as const) {
      const renew = vi.fn(async () => { if (result === "throw") throw new Error("secret"); return result; }); const { lock, timers, clear } = setup({ renewIfOwner: renew });
      const lease = (await lock.acquire({ bankCode: "popular" }))!; timers[0](); timers[0](); await Promise.resolve(); await Promise.resolve();
      expect([lease.signal.aborted, renew.mock.calls.length, clear.mock.calls.length]).toEqual([true, 1, 1]);
    }
  });
  it("stops before one shared release waits for renewal and reports the store result", async () => {
    const pending = deferred<boolean>(); const release = vi.fn(async () => false); const { lock, timers, clear, calls } = setup({ renewIfOwner: async () => pending.promise, releaseIfOwner: release });
    const lease = (await lock.acquire({ bankCode: "popular" }))!; timers[0](); const first = lease.release(); const second = lease.release();
    expect([first === second, clear.mock.calls.length, calls]).toEqual([true, 1, ["acquire:autologin:lock:v3:bank-authentication:{popular}"]]);
    pending.resolve(true); await expect(first).resolves.toBe(false); expect(release.mock.calls.length).toBe(1);
  });
  it("does not schedule when acquire is busy or fails and validates construction", async () => {
    for (const [acquireSlot, rejected] of [[async () => null, false], [async () => { throw new Error("secret"); }, true]] as const) {
      const { lock, timers } = setup({ acquireSlot }); const result = lock.acquire({ bankCode: "popular" }); if (rejected) await expect(result).rejects.toThrow(); else await expect(result).resolves.toBeNull(); expect(timers).toEqual([]);
    }
    expect(() => createRenewableBankAuthenticationLock({ store: {} as LockStore, ttlMs: 0 })).toThrow();
    expect(() => createRenewableBankAuthenticationLock({ store: {} as LockStore, ttlMs: 10, renewIntervalMs: 10 })).toThrow();
  });
});
