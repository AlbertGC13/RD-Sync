import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { RedisEvalClient } from "./redis-store";
import { createAutoLoginLockFromEnv } from "./defaults";

// ---------------------------------------------------------------------------
// Fake Redis client — same contract as redis-store.test.ts
// ---------------------------------------------------------------------------

class FakeRedisClient implements RedisEvalClient {
  private store = new Map<string, string>();
  private expiry = new Map<string, number>();
  private fenceCounters = new Map<string, number>();
  public now = Date.now();

  private isExpired(key: string): boolean {
    const exp = this.expiry.get(key);
    if (exp == null) return false;
    if (this.now >= exp) {
      this.store.delete(key);
      this.expiry.delete(key);
      return true;
    }
    return false;
  }

  async eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown> {
    const keys = args.slice(0, numKeys) as string[];
    const scriptArgs = args.slice(numKeys);

    const isAcquire = script.includes("INCR") && script.includes("fenceKey");
    const isRelease = script.includes("expectedToken") && script.includes("DEL") && !script.includes("INCR");
    const isRenew = script.includes("newTtlMs") && script.includes("SET") && !script.includes("INCR");

    if (isAcquire) {
      const [lockKey, fenceKey, leaseToken, ttlMs] = [keys[0], keys[1], scriptArgs[0] as string, Number(scriptArgs[1])];
      if (!this.isExpired(lockKey) && this.store.has(lockKey)) return null;
      const next = (this.fenceCounters.get(fenceKey) ?? 0) + 1;
      this.fenceCounters.set(fenceKey, next);
      this.store.set(lockKey, JSON.stringify({ leaseToken, fencingToken: next }));
      this.expiry.set(lockKey, this.now + ttlMs);
      return next;
    }

    if (isRelease) {
      const expected = scriptArgs[0] as string;
      if (this.isExpired(keys[0])) return 0;
      const raw = this.store.get(keys[0]);
      if (!raw) return 0;
      const d = JSON.parse(raw) as { leaseToken: string };
      if (d.leaseToken !== expected) return 0;
      this.store.delete(keys[0]);
      this.expiry.delete(keys[0]);
      return 1;
    }

    if (isRenew) {
      const [expected, ttlMs] = [scriptArgs[0] as string, Number(scriptArgs[1])];
      if (this.isExpired(keys[0])) return 0;
      const raw = this.store.get(keys[0]);
      if (!raw) return 0;
      const d = JSON.parse(raw) as { leaseToken: string; fencingToken: number; expiresAt: number };
      if (d.leaseToken !== expected) return 0;
      this.expiry.set(keys[0], this.now + ttlMs);
      this.store.set(keys[0], JSON.stringify({ ...d, expiresAt: this.now + ttlMs }));
      return 1;
    }

    throw new Error("Unexpected Lua script");
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("createAutoLoginLockFromEnv", () => {
  const originalEnv = process.env.RD_SYNC_REDIS_URL;
  let fakeRedis: FakeRedisClient;

  beforeEach(() => {
    fakeRedis = new FakeRedisClient();
    fakeRedis.now = Date.now();
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.RD_SYNC_REDIS_URL = originalEnv;
    } else {
      delete process.env.RD_SYNC_REDIS_URL;
    }
  });

  it("returns an AutoLoginLock when RD_SYNC_REDIS_URL is set", () => {
    process.env.RD_SYNC_REDIS_URL = "redis://localhost:6379";
    const lock = createAutoLoginLockFromEnv(process.env, { redisClientFactory: () => fakeRedis });
    expect(lock).toBeDefined();
    expect(typeof lock!.acquire).toBe("function");
    expect(typeof lock!.release).toBe("function");
    expect(typeof lock!.renew).toBe("function");
  });

  it("lock acquires and releases via Redis-backed store", async () => {
    process.env.RD_SYNC_REDIS_URL = "redis://localhost:6379";
    const lock = createAutoLoginLockFromEnv(process.env, { redisClientFactory: () => fakeRedis })!;

    const acquired = await lock.acquire("popular", "evt-001");
    expect(acquired).not.toBeNull();
    expect(acquired!.fencingToken).toBe(1);
    expect(acquired!.leaseToken).toBeTypeOf("string");
    expect(acquired!.expiresAt).toBeGreaterThan(Date.now());

    const released = await lock.release("popular", "evt-001", acquired!.leaseToken);
    expect(released).toBe(true);
  });

  it("returns null when lock is already held", async () => {
    process.env.RD_SYNC_REDIS_URL = "redis://localhost:6379";
    const lock = createAutoLoginLockFromEnv(process.env, { redisClientFactory: () => fakeRedis })!;

    const first = await lock.acquire("popular", "evt-001");
    expect(first).not.toBeNull();

    const second = await lock.acquire("popular", "evt-001");
    expect(second).toBeNull();
  });

  it("returns null when RD_SYNC_REDIS_URL is not set", () => {
    delete process.env.RD_SYNC_REDIS_URL;
    expect(createAutoLoginLockFromEnv(process.env, { redisClientFactory: () => fakeRedis })).toBeNull();
  });

  it("creates new instances on each call (no hidden singleton in factory)", () => {
    process.env.RD_SYNC_REDIS_URL = "redis://localhost:6379";
    const a = createAutoLoginLockFromEnv(process.env, { redisClientFactory: () => fakeRedis });
    const b = createAutoLoginLockFromEnv(process.env, { redisClientFactory: () => fakeRedis });
    // Factory path does not cache — each call creates a fresh lock.
    // This is intentional: callers that want a singleton use defaultAutoLoginLock.
    expect(a).not.toBe(b);
  });

  it("passes lazyConnect: true to the redisClientFactory (BUG-RL regression)", () => {
    process.env.RD_SYNC_REDIS_URL = "redis://localhost:6379";
    const receivedOpts: unknown[] = [];
    createAutoLoginLockFromEnv(process.env, {
      redisClientFactory: (opts) => {
        receivedOpts.push(opts);
        return fakeRedis;
      },
    });
    expect(receivedOpts).toHaveLength(1);
    expect(receivedOpts[0]).toHaveProperty("lazyConnect", true);
  });

  it("lock options use bounded maxRetriesPerRequest, not null (BUG-RO regression)", () => {
    process.env.RD_SYNC_REDIS_URL = "redis://localhost:6379";
    const receivedOpts: Record<string, unknown>[] = [];
    createAutoLoginLockFromEnv(process.env, {
      redisClientFactory: (opts) => {
        receivedOpts.push(opts);
        return fakeRedis;
      },
    });
    expect(receivedOpts).toHaveLength(1);
    const opts = receivedOpts[0];
    // Lock must NOT use maxRetriesPerRequest:null (BullMQ-only) — that causes
    // indefinite hangs during Redis outages.  Use a finite value instead.
    expect(opts.maxRetriesPerRequest).not.toBeNull();
    expect(typeof opts.maxRetriesPerRequest).toBe("number");
    expect(opts.maxRetriesPerRequest).toBeGreaterThan(0);
    // Bounded timeouts for fail-closed behavior
    expect(opts.connectTimeout).toBeTypeOf("number");
    expect(opts.commandTimeout).toBeTypeOf("number");
  });

  it("renew extends TTL so lock survives past original expiry", async () => {
    process.env.RD_SYNC_REDIS_URL = "redis://localhost:6379";
    fakeRedis.now = 1_000_000;
    const lock = createAutoLoginLockFromEnv(process.env, { redisClientFactory: () => fakeRedis })!;

    // Acquire with short TTL (30s) — without renewal, lock expires at T+30s
    const acquired = await lock.acquire("popular", "evt-001", 30_000);
    expect(acquired).not.toBeNull();

    // Renew with longer TTL (90s) — extends lock expiry to T+90s
    const renewed = await lock.renew("popular", "evt-001", acquired!.leaseToken, 90_000);
    expect(renewed).toBe(true);

    // Advance past original TTL (50s > 30s) but within renewed TTL (50s < 90s)
    fakeRedis.now = 1_050_000;
    // Lock should still be held — renewal kept it alive past original expiry
    const stillHeld = await lock.acquire("popular", "evt-001");
    expect(stillHeld).toBeNull();

    // Advance past renewed TTL (95s > 90s) — lock expires
    fakeRedis.now = 1_095_000;
    const second = await lock.acquire("popular", "evt-001");
    expect(second).not.toBeNull();
    // Old lease cannot release after lock expiry + new acquire
    expect(await lock.release("popular", "evt-001", acquired!.leaseToken)).toBe(false);
    expect(await lock.release("popular", "evt-001", second!.leaseToken)).toBe(true);
  });
});

describe("defaultAutoLoginLock (globalThis singleton)", () => {
  const originalEnv = process.env.RD_SYNC_REDIS_URL;

  afterEach(() => {
    // Restore ambient env and clean up globalThis singleton between tests
    if (originalEnv !== undefined) {
      process.env.RD_SYNC_REDIS_URL = originalEnv;
    } else {
      delete process.env.RD_SYNC_REDIS_URL;
    }
    delete (globalThis as Record<string, unknown>).__rdSyncAutoLoginLock;
    vi.resetModules();
  });

  it("is null when RD_SYNC_REDIS_URL is not set at module load", async () => {
    // Deterministic: explicitly clear env + globalThis singleton, then dynamic import.
    // This test passes regardless of ambient RD_SYNC_REDIS_URL.
    delete process.env.RD_SYNC_REDIS_URL;
    delete (globalThis as Record<string, unknown>).__rdSyncAutoLoginLock;
    vi.resetModules();
    const mod = await import("./defaults");
    expect(mod.defaultAutoLoginLock).toBeNull();
  });

  it("initializes non-null when RD_SYNC_REDIS_URL is set at module evaluation (BUG-S1 regression)", async () => {
    // BUG-S1 regression: the singleton never initialized because `undefined`
    // (missing globalThis slot) was not distinguished from UNINITIALIZED.
    // This test dynamically imports the module with env set to verify the fix.
    delete (globalThis as Record<string, unknown>).__rdSyncAutoLoginLock;
    process.env.RD_SYNC_REDIS_URL = "redis://localhost:6379";
    vi.resetModules();
    try {
      const mod = await import("./defaults");
      expect(mod.defaultAutoLoginLock).not.toBeNull();
      expect(typeof mod.defaultAutoLoginLock!.acquire).toBe("function");
    } finally {
      delete process.env.RD_SYNC_REDIS_URL;
      delete (globalThis as Record<string, unknown>).__rdSyncAutoLoginLock;
      vi.resetModules();
    }
  });
});
