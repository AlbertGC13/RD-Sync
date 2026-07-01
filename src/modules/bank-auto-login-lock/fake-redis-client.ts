import type { RedisEvalClient } from "./redis-store";

/**
 * Shared fake Redis client for lock-store tests.
 *
 * Simulates the Lua EVAL contracts (acquire / release / renew) with native
 * TTL semantics so unit tests can run without a real Redis instance.
 *
 * Used by `redis-store.test.ts` and `defaults.test.ts`.
 */
export class FakeRedisClient implements RedisEvalClient {
  private store = new Map<string, string>();
  private expiry = new Map<string, number>();
  private fenceCounters = new Map<string, number>();

  /** Record of every EVAL call for assertion purposes. */
  public evalCalls: { script: string; keys: string[]; args: (string | number)[] }[] = [];

  /** When set, the next EVAL call throws this error (then clears). */
  public nextEvalError?: Error;

  /** Simulated current time — advance manually to exercise TTL logic. */
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
    if (this.nextEvalError) {
      const e = this.nextEvalError;
      this.nextEvalError = undefined;
      throw e;
    }

    const keys = args.slice(0, numKeys) as string[];
    const sa = args.slice(numKeys);
    this.evalCalls.push({ script, keys, args: sa });

    const isAcquire = script.includes("INCR") && script.includes("fenceKey");
    const isRelease = script.includes("expectedToken") && script.includes("DEL") && !script.includes("INCR");
    const isRenew = script.includes("newTtlMs") && script.includes("SET") && !script.includes("INCR");

    if (isAcquire) {
      const [lockKey, fenceKey, leaseToken, ttlMs] = [keys[0], keys[1], sa[0] as string, Number(sa[1])];
      if (!this.isExpired(lockKey) && this.store.has(lockKey)) return null;
      const next = (this.fenceCounters.get(fenceKey) ?? 0) + 1;
      this.fenceCounters.set(fenceKey, next);
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
      this.store.delete(keys[0]);
      this.expiry.delete(keys[0]);
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

    throw new Error("Unexpected Lua script");
  }
}
