import { describe, it, expect, vi, beforeEach } from "vitest";
import { RedisLockStore, type RedisEvalClient } from "./redis-store";

/** Fake Redis client — simulates Lua contracts with native TTL semantics. */
class FakeRedisClient implements RedisEvalClient {
  private store = new Map<string, string>();
  private expiry = new Map<string, number>();
  public evalCalls: { script: string; keys: string[]; args: (string | number)[] }[] = [];
  public nextEvalError?: Error;
  public now = Date.now();
  private isExpired(key: string): boolean {
    const exp = this.expiry.get(key);
    if (exp == null) return false;
    if (this.now >= exp) { this.store.delete(key); this.expiry.delete(key); return true; }
    return false;
  }

  async eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown> {
    if (this.nextEvalError) { const e = this.nextEvalError; this.nextEvalError = undefined; throw e; }
    const keys = args.slice(0, numKeys) as string[];
    const sa = args.slice(numKeys);
    this.evalCalls.push({ script, keys, args: sa });
    const isAcquire = script.includes("INCR") && script.includes("fenceKey");
    const isRelease = script.includes("expectedToken") && script.includes("DEL") && !script.includes("INCR");
    const isRenew = script.includes("newTtlMs") && script.includes("SET") && !script.includes("INCR");
    if (isAcquire) {
      const [lockKey, fenceKey, leaseToken, ttlMs] = [keys[0], keys[1], sa[0] as string, Number(sa[1])];
      if (!this.isExpired(lockKey) && this.store.has(lockKey)) return null;
      const next = Number(this.store.get(fenceKey) ?? 0) + 1;
      this.store.set(fenceKey, String(next));
      this.store.set(lockKey, JSON.stringify({ leaseToken, fencingToken: next }));
      this.expiry.set(lockKey, this.now + ttlMs);
      return next;
    }
    if (isRelease) {
      const expected = sa[0] as string;
      if (this.isExpired(keys[0])) return 0;
      const raw = this.store.get(keys[0]);
      if (!raw) return 0;
      const d = JSON.parse(raw) as { leaseToken: string };
      if (d.leaseToken !== expected) return 0;
      this.store.delete(keys[0]); this.expiry.delete(keys[0]);
      return 1;
    }
    if (isRenew) {
      const [expected, ttlMs] = [sa[0] as string, Number(sa[1])];
      if (this.isExpired(keys[0])) return 0;
      const raw = this.store.get(keys[0]);
      if (!raw) return 0;
      const d = JSON.parse(raw) as { leaseToken: string };
      if (d.leaseToken !== expected) return 0;
      this.expiry.set(keys[0], this.now + ttlMs);
      this.store.set(keys[0], JSON.stringify(d));
      return 1;
    }
    throw new Error(`Unexpected script`);
  }
}

describe("RedisLockStore", () => {
  let redis: FakeRedisClient;
  let store: RedisLockStore;
  let t: number;

  beforeEach(() => {
    t = 1_000_000;
    redis = new FakeRedisClient();
    redis.now = t;
    store = new RedisLockStore({ client: redis });
  });

  const key = "autologin:lock:popular:evt-001";

  describe("acquireSlot", () => {
    it("uses atomic eval and returns fencing token", async () => {
      expect(await store.acquireSlot({ key, leaseToken: "t1", ttlMs: 60_000, nowMs: t })).toBe(1);
      expect(redis.evalCalls).toHaveLength(1);
      expect(redis.evalCalls[0].keys).toEqual([key, `${key}:fence`]);
    });

    it("returns null when lock is held", async () => {
      await store.acquireSlot({ key, leaseToken: "t1", ttlMs: 60_000, nowMs: t });
      expect(await store.acquireSlot({ key, leaseToken: "t2", ttlMs: 60_000, nowMs: t })).toBeNull();
    });

    it("acquires after TTL expiry (Redis-native)", async () => {
      expect(await store.acquireSlot({ key, leaseToken: "t1", ttlMs: 5000, nowMs: t })).toBe(1);
      redis.now = t + 6000;
      expect(await store.acquireSlot({ key, leaseToken: "t2", ttlMs: 5000, nowMs: t + 6000 })).toBe(2);
    });

    it("fencing tokens are independent per key", async () => {
      const k2 = "autologin:lock:popular:evt-002";
      const k3 = "autologin:lock:banreservas:evt-001";
      expect(await store.acquireSlot({ key, leaseToken: "a", ttlMs: 60_000, nowMs: t })).toBe(1);
      expect(await store.acquireSlot({ key: k2, leaseToken: "b", ttlMs: 60_000, nowMs: t })).toBe(1);
      expect(await store.acquireSlot({ key: k3, leaseToken: "c", ttlMs: 60_000, nowMs: t })).toBe(1);
    });

    it("normalizes non-integer/non-positive returns to null; positive ints to fencing token", async () => {
      const orig = redis.eval.bind(redis);
      for (const badReturn of [false, true, 0, "0", 1.5, "1.5"]) {
        let called = false;
        redis.eval = async (script, numKeys, ...rest) => {
          if (!called) { called = true; return badReturn; }
          return orig(script, numKeys, ...rest);
        };
        expect(await store.acquireSlot({ key, leaseToken: "x", ttlMs: 30_000, nowMs: t })).toBeNull();
        called = false;
      }
      redis.eval = async () => { return 42; };
      expect(await store.acquireSlot({ key, leaseToken: "x", ttlMs: 30_000, nowMs: t })).toBe(42);
      redis.eval = orig;
    });
  });

  describe("releaseIfOwner", () => {
    it("deletes lock when token matches and allows re-acquire", async () => {
      await store.acquireSlot({ key, leaseToken: "t1", ttlMs: 60_000, nowMs: t });
      expect(await store.releaseIfOwner(key, "t1")).toBe(true);
      expect(await store.acquireSlot({ key, leaseToken: "t2", ttlMs: 60_000, nowMs: t })).toBe(2);
    });

    it("returns false for wrong token and lock stays held", async () => {
      await store.acquireSlot({ key, leaseToken: "t1", ttlMs: 60_000, nowMs: t });
      expect(await store.releaseIfOwner(key, "wrong")).toBe(false);
      expect(await store.acquireSlot({ key, leaseToken: "t2", ttlMs: 60_000, nowMs: t })).toBeNull();
    });

    it("returns false when expired (Redis-native TTL)", async () => {
      await store.acquireSlot({ key, leaseToken: "t1", ttlMs: 5000, nowMs: t });
      redis.now = t + 6000;
      expect(await store.releaseIfOwner(key, "t1")).toBe(false);
    });

    it("returns false for non-existent key", async () => {
      expect(await store.releaseIfOwner("missing", "t1")).toBe(false);
    });
  });

  describe("renewIfOwner", () => {
    it("extends TTL when token matches", async () => {
      await store.acquireSlot({ key, leaseToken: "t1", ttlMs: 5000, nowMs: t });
      redis.now = t + 2000;
      expect(await store.renewIfOwner({ key, expectedLeaseToken: "t1", newTtlMs: 10_000, nowMs: t + 2000 })).toBe(true);
      redis.now = t + 6000;
      expect(await store.acquireSlot({ key, leaseToken: "t2", ttlMs: 5000, nowMs: t + 6000 })).toBeNull();
    });

    it("returns false for wrong token or expired", async () => {
      await store.acquireSlot({ key, leaseToken: "t1", ttlMs: 60_000, nowMs: t });
      expect(await store.renewIfOwner({ key, expectedLeaseToken: "wrong", newTtlMs: 60_000, nowMs: t + 1 })).toBe(false);
      const r2 = new FakeRedisClient(); r2.now = t;
      const s2 = new RedisLockStore({ client: r2 });
      await s2.acquireSlot({ key, leaseToken: "t1", ttlMs: 5000, nowMs: t });
      r2.now = t + 6000;
      expect(await s2.renewIfOwner({ key, expectedLeaseToken: "t1", newTtlMs: 60_000, nowMs: t + 6000 })).toBe(false);
    });
  });

  describe("script invocation", () => {
    it("acquire passes correct keys and args (no nowMs)", async () => {
      await store.acquireSlot({ key, leaseToken: "t1", ttlMs: 30_000, nowMs: 1_000_000 });
      expect(redis.evalCalls[0].args).toEqual(["t1", 30_000]);
      expect(redis.evalCalls[0].keys).toEqual([key, `${key}:fence`]);
    });

    it("release and renew pass correct keys (no nowMs)", async () => {
      await store.acquireSlot({ key, leaseToken: "t1", ttlMs: 30_000, nowMs: t });
      await store.releaseIfOwner(key, "t1");
      expect(redis.evalCalls[1].keys).toEqual([key]);
      expect(redis.evalCalls[1].args).toEqual(["t1"]);
      await store.acquireSlot({ key, leaseToken: "t2", ttlMs: 30_000, nowMs: t });
      await store.renewIfOwner({ key, expectedLeaseToken: "t2", newTtlMs: 60_000, nowMs: t + 1 });
      expect(redis.evalCalls[3].keys).toEqual([key]);
      expect(redis.evalCalls[3].args).toEqual(["t2", 60_000]);
    });
  });

  describe("error handling", () => {
    it("propagates Redis errors", async () => {
      redis.nextEvalError = new Error("ECONNREFUSED");
      await expect(store.acquireSlot({ key, leaseToken: "t", ttlMs: 30_000, nowMs: t })).rejects.toThrow("ECONNREFUSED");
      await store.acquireSlot({ key, leaseToken: "t", ttlMs: 30_000, nowMs: t });
      redis.nextEvalError = new Error("READONLY");
      await expect(store.releaseIfOwner(key, "t")).rejects.toThrow("READONLY");
      redis.nextEvalError = new Error("ETIMEDOUT");
      await expect(store.renewIfOwner({ key, expectedLeaseToken: "t", newTtlMs: 60_000, nowMs: t + 1 })).rejects.toThrow("ETIMEDOUT");
    });
  });

  describe("structural interface", () => {
    it("accepts bare eval-only client", () => {
      const s = new RedisLockStore({ eval: vi.fn().mockResolvedValue(null) } as RedisEvalClient);
      expect(s).toBeInstanceOf(RedisLockStore);
    });

    it("handles string numeric responses (Redis RESP2)", async () => {
      const orig = redis.eval.bind(redis);
      let n = 0;
      redis.eval = async (script, numKeys, ...rest) => { n++; const r = await orig(script, numKeys, ...rest); return n === 1 && typeof r === "number" ? String(r) : r; };
      expect(await store.acquireSlot({ key, leaseToken: "t", ttlMs: 30_000, nowMs: t })).toBe(1);
    });

    it("handles numeric/string Redis returns for release and renew", async () => {
      await store.acquireSlot({ key, leaseToken: "t1", ttlMs: 60_000, nowMs: t });
      const orig = redis.eval.bind(redis);
      redis.eval = async (s, n, ...r) => { const v = await orig(s, n, ...r); return typeof v === "number" ? String(v) : v; };
      expect(await store.releaseIfOwner(key, "t1")).toBe(true);
      await store.acquireSlot({ key, leaseToken: "t2", ttlMs: 60_000, nowMs: t });
      expect(await store.renewIfOwner({ key, expectedLeaseToken: "t2", newTtlMs: 60_000, nowMs: t })).toBe(true);
    });
  });
});
