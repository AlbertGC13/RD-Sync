import { describe, it, expect } from "vitest";
import {
  createAutoLoginLock,
  buildLockKey,
  LockValidationError,
  DEFAULT_LOCK_TTL_MS,
  MAX_LOCK_TTL_MS,
  LOCK_KEY_PREFIX,
} from "./index";

class InMemoryLockStore {
  private store = new Map<string, string>();
  private counters = new Map<string, number>();
  constructor(private readonly now?: () => number) {}
  async acquireSlot(key: string, leaseToken: string, ttlMs: number, nowMs: number): Promise<number | null> {
    const raw = this.store.get(key);
    if (raw) {
      const d = JSON.parse(raw) as { expiresAt: number; fencingToken: number };
      if (d.expiresAt > nowMs) return null;
      this.counters.set(key, d.fencingToken + 1);
    } else {
      this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
    }
    const ft = this.counters.get(key)!;
    this.store.set(key, JSON.stringify({ leaseToken, fencingToken: ft, expiresAt: nowMs + ttlMs }));
    return ft;
  }
  async releaseIfOwner(key: string, expected: string): Promise<boolean> {
    const raw = this.store.get(key);
    if (!raw) return false;
    const d = JSON.parse(raw) as { leaseToken: string; expiresAt: number };
    if (d.leaseToken !== expected) return false;
    if (d.expiresAt <= (this.now?.() ?? Infinity)) { this.store.delete(key); return false; }
    this.store.delete(key);
    return true;
  }
  async renewIfOwner(key: string, expected: string, newTtlMs: number, nowMs: number): Promise<boolean> {
    const raw = this.store.get(key);
    if (!raw) return false;
    const d = JSON.parse(raw) as { leaseToken: string; fencingToken: number; expiresAt: number };
    if (d.leaseToken !== expected || d.expiresAt <= nowMs) return false;
    this.store.set(key, JSON.stringify({ ...d, expiresAt: nowMs + newTtlMs }));
    return true;
  }
}

function setup(opts?: { defaultTtlMs?: number; maxTtlMs?: number; now?: () => number }) {
  const startTimeMs = 1_000_000;
  const now = opts?.now ?? (() => startTimeMs);
  const store = new InMemoryLockStore(now);
  const lock = createAutoLoginLock({
    store,
    defaultTtlMs: opts?.defaultTtlMs ?? DEFAULT_LOCK_TTL_MS,
    maxTtlMs: opts?.maxTtlMs ?? MAX_LOCK_TTL_MS,
    now,
  });
  return { store, lock, startTimeMs };
}

describe("AutoLoginLock", () => {
  describe("acquire", () => {
    it("returns lease with leaseToken, fencingToken=1, and expiresAt", async () => {
      const { lock, startTimeMs } = setup();
      const r = await lock.acquire("popular", "evt-001");
      expect(r).not.toBeNull();
      expect(r!.leaseToken).toBeTypeOf("string");
      expect(r!.leaseToken.length).toBeGreaterThan(0);
      expect(r!.fencingToken).toBe(1);
      expect(r!.expiresAt).toBe(startTimeMs + DEFAULT_LOCK_TTL_MS);
    });
    it("returns null when lock is already held", async () => {
      const { lock } = setup();
      expect(await lock.acquire("popular", "evt-001")).not.toBeNull();
      expect(await lock.acquire("popular", "evt-001")).toBeNull();
    });
    it("returns null when held by a different owner instance", async () => {
      let counter = 0;
      const now = () => 1_000_000;
      const store = new InMemoryLockStore(now);
      const mk = () => createAutoLoginLock({
        store, defaultTtlMs: 60_000, now,
        generateLeaseToken: () => `lease-${++counter}`,
      });
      expect(await mk().acquire("popular", "evt-001")).not.toBeNull();
      expect(await mk().acquire("popular", "evt-001")).toBeNull();
    });
  });

  describe("release", () => {
    it("succeeds for matching leaseToken", async () => {
      const { lock } = setup();
      const acquired = await lock.acquire("popular", "evt-001");
      expect(await lock.release("popular", "evt-001", acquired!.leaseToken)).toBe(true);
    });
    it("fails for wrong leaseToken (stale owner)", async () => {
      const { lock } = setup();
      await lock.acquire("popular", "evt-001");
      expect(await lock.release("popular", "evt-001", "wrong-token")).toBe(false);
    });
    it("fails for stale leaseToken after new acquire", async () => {
      let timeMs = 1_000_000;
      const now = () => timeMs;
      const lock = createAutoLoginLock({ store: new InMemoryLockStore(now), defaultTtlMs: 1000, now });
      const first = await lock.acquire("popular", "evt-001");
      timeMs += 2000;
      const second = await lock.acquire("popular", "evt-001");
      expect(await lock.release("popular", "evt-001", first!.leaseToken)).toBe(false);
      expect(await lock.release("popular", "evt-001", second!.leaseToken)).toBe(true);
    });
  });

  describe("renew", () => {
    it("succeeds for matching leaseToken", async () => {
      const { lock } = setup();
      const acquired = await lock.acquire("popular", "evt-001");
      expect(await lock.renew("popular", "evt-001", acquired!.leaseToken, 60_000)).toBe(true);
    });
    it("extends TTL from current time, not original", async () => {
      let timeMs = 1_000_000;
      const now = () => timeMs;
      const lock = createAutoLoginLock({ store: new InMemoryLockStore(now), defaultTtlMs: 5_000, maxTtlMs: 60_000, now });
      const ac = await lock.acquire("popular", "evt-001");
      expect(ac!.expiresAt).toBe(1_005_000);
      timeMs = 1_002_000;
      expect(await lock.renew("popular", "evt-001", ac!.leaseToken, 10_000)).toBe(true);
      timeMs = 1_008_000;
      expect(await lock.acquire("popular", "evt-001")).toBeNull();
      timeMs = 1_012_001;
      expect((await lock.acquire("popular", "evt-001"))!.fencingToken).toBe(2);
    });
    it("fails for expired lease after new owner acquired", async () => {
      let timeMs = 1_000_000;
      const now = () => timeMs;
      const lock = createAutoLoginLock({ store: new InMemoryLockStore(now), defaultTtlMs: 1000, now });
      const first = await lock.acquire("popular", "evt-001");
      timeMs += 2000;
      const second = await lock.acquire("popular", "evt-001");
      expect(await lock.renew("popular", "evt-001", first!.leaseToken)).toBe(false);
      expect(await lock.renew("popular", "evt-001", second!.leaseToken)).toBe(true);
    });
  });

  describe("max TTL enforcement", () => {
    it.each([
      ["acquire", (l: ReturnType<typeof createAutoLoginLock>) => l.acquire("popular", "evt-001", 60_001)],
      ["renew", async (l: ReturnType<typeof createAutoLoginLock>) => {
        const a = await l.acquire("popular", "evt-001");
        return l.renew("popular", "evt-001", a!.leaseToken, 60_001);
      }],
    ])("rejects %s TTL exceeding maxTtlMs", async (_, op) => {
      const { lock } = setup({ defaultTtlMs: 30_000, maxTtlMs: 60_000 });
      await expect(op(lock)).rejects.toThrow(LockValidationError);
    });
    it("accepts TTL at and below maxTtlMs", async () => {
      const { lock } = setup({ maxTtlMs: 60_000 });
      expect(await lock.acquire("popular", "evt-001", 60_000)).not.toBeNull();
      expect(await lock.acquire("popular", "evt-002", 5_000)).not.toBeNull();
    });
    it("defaults maxTtlMs to 15 minutes", async () => {
      expect(MAX_LOCK_TTL_MS).toBe(15 * 60 * 1000);
      const { lock } = setup();
      await expect(lock.acquire("popular", "evt-001", MAX_LOCK_TTL_MS + 1)).rejects.toThrow(LockValidationError);
    });
  });

  describe("expired-token release semantics", () => {
    it("release before re-acquire on expired lock returns false and cleans up (matching Redis expiry)", async () => {
      let timeMs = 1_000_000;
      const now = () => timeMs;
      const lock = createAutoLoginLock({ store: new InMemoryLockStore(now), defaultTtlMs: 1000, now });
      const first = await lock.acquire("popular", "evt-001");
      timeMs += 2000;
      expect(await lock.release("popular", "evt-001", first!.leaseToken)).toBe(false);
      const second = await lock.acquire("popular", "evt-001");
      expect(second).not.toBeNull();
      expect(second!.fencingToken).toBe(2);
    });
    it("release after owner expiry fails like Redis (lease mismatch after re-acquire)", async () => {
      let timeMs = 1_000_000;
      const now = () => timeMs;
      const lock = createAutoLoginLock({ store: new InMemoryLockStore(now), defaultTtlMs: 1000, now });
      const first = await lock.acquire("popular", "evt-001");
      timeMs += 2000;
      const second = await lock.acquire("popular", "evt-001");
      expect(second).not.toBeNull();
      expect(await lock.release("popular", "evt-001", first!.leaseToken)).toBe(false);
      expect(await lock.release("popular", "evt-001", second!.leaseToken)).toBe(true);
    });
  });

  describe("fencing tokens", () => {
    it("increase on each re-acquire after release", async () => {
      const { lock } = setup();
      const a1 = await lock.acquire("popular", "evt-001");
      expect(a1!.fencingToken).toBe(1);
      await lock.release("popular", "evt-001", a1!.leaseToken);
      const a2 = await lock.acquire("popular", "evt-001");
      expect(a2!.fencingToken).toBe(2);
      await lock.release("popular", "evt-001", a2!.leaseToken);
      const a3 = await lock.acquire("popular", "evt-001");
      expect(a3!.fencingToken).toBe(3);
    });
    it("increase on re-acquire after expiry", async () => {
      let timeMs = 1_000_000;
      const now = () => timeMs;
      const lock = createAutoLoginLock({ store: new InMemoryLockStore(now), defaultTtlMs: 1000, now });
      expect((await lock.acquire("popular", "evt-001"))!.fencingToken).toBe(1);
      timeMs += 2000;
      expect((await lock.acquire("popular", "evt-001"))!.fencingToken).toBe(2);
    });
    it("are independent per key and bank", async () => {
      const { lock } = setup();
      const a1 = await lock.acquire("popular", "evt-001");
      const a2 = await lock.acquire("popular", "evt-002");
      const a3 = await lock.acquire("banreservas", "evt-001");
      expect(a1!.fencingToken).toBe(1);
      expect(a2!.fencingToken).toBe(1);
      expect(a3!.fencingToken).toBe(1);
      await lock.release("popular", "evt-001", a1!.leaseToken);
      expect((await lock.acquire("popular", "evt-001"))!.fencingToken).toBe(2);
      expect(await lock.acquire("popular", "evt-002")).toBeNull();
    });
  });

  describe("input validation", () => {
    it.each([
      ["", "empty bankCode"], ["POPULAR", "uppercase"], ["popular-bank!", "special chars"],
      ["1invalid", "starts with digit"], ["a".repeat(33), "exceeds 32 chars"],
    ])("rejects invalid bankCode %j (%s)", async (bankCode) => {
      const { lock } = setup();
      await expect(lock.acquire(bankCode, "evt-001")).rejects.toThrow(LockValidationError);
    });
    it.each([
      ["", "empty"], ["evt with spaces", "spaces"], ["evt!@#", "special chars"],
      ["a".repeat(65), "exceeds 64 chars"],
    ])("rejects invalid expiredEventId %j (%s)", async (eventId) => {
      const { lock } = setup();
      await expect(lock.acquire("popular", eventId)).rejects.toThrow(LockValidationError);
    });
    it("accepts valid bank codes and UUID-style eventIds", async () => {
      const { lock } = setup();
      for (const code of ["popular", "banreservas", "my_bank-2"]) {
        expect(await lock.acquire(code, "evt-001")).not.toBeNull();
      }
      expect(await lock.acquire("popular", "550e8400-e29b-41d4-a716-446655440000")).not.toBeNull();
    });
    it.each([
      ["release", (l: ReturnType<typeof createAutoLoginLock>) => l.release("popular", "evt-001", "")],
      ["renew", (l: ReturnType<typeof createAutoLoginLock>) => l.renew("popular", "evt-001", "")],
    ])("rejects empty leaseToken in %s", async (_, op) => {
      await expect(op(setup().lock)).rejects.toThrow(LockValidationError);
    });
    it.each([
      ["acquire", (l: ReturnType<typeof createAutoLoginLock>) => l.acquire("popular", "evt-001", 0)],
      ["acquire", (l: ReturnType<typeof createAutoLoginLock>) => l.acquire("popular", "evt-001", -1000)],
      ["renew", async (l: ReturnType<typeof createAutoLoginLock>) => {
        const a = await l.acquire("popular", "evt-001");
        return l.renew("popular", "evt-001", a!.leaseToken, 0);
      }],
    ])("rejects non-positive TTL in %s", async (_, op) => {
      await expect(op(setup().lock)).rejects.toThrow(LockValidationError);
    });
    it("uses correct key prefix and defaults", () => {
      expect(buildLockKey("popular", "evt-001")).toBe("autologin:lock:popular:evt-001");
      expect(LOCK_KEY_PREFIX).toBe("autologin:lock");
      expect(DEFAULT_LOCK_TTL_MS).toBe(5 * 60 * 1000);
    });
  });
});
