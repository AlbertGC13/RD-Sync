/**
 * Redis-backed LockStore adapter for AutoLoginLock.
 *
 * Uses atomic Lua scripts via Redis `EVAL` for compare-and-set semantics.
 * A structural `RedisEvalClient` interface decouples from any specific Redis
 * driver — callers inject their own connection.
 */

import type {
  AcquireSlotParams,
  LockStore,
  RenewIfOwnerParams,
} from "./index";

// ---------------------------------------------------------------------------
// Structural Redis client — only EVAL is needed (no ioredis import)
// ---------------------------------------------------------------------------

/** Minimal eval-only interface matching ioredis / Redis client eval signature. */
export interface RedisEvalClient {
  eval(
    script: string,
    numKeys: number,
    ...args: (string | number)[]
  ): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Lua scripts — atomic CAS operations
// ---------------------------------------------------------------------------

/**
 * acquireSlot: atomically check-and-set a lock key.
 *
 * Returns the new fencing token (number) on success, or nil (null) if the key
 * is already held and not expired. The fencing counter is incremented
 * monotonically per lock key, ensuring stale leases cannot overwrite newer
 * state writes via CAS.
 *
 * KEYS[1] = lock key
 * KEYS[2] = fencing counter key
 * ARGV[1] = lease token
 * ARGV[2] = TTL in milliseconds
 */
const ACQUIRE_SCRIPT = `
local lockKey = KEYS[1]
local fenceKey = KEYS[2]
local leaseToken = ARGV[1]
local ttlMs = tonumber(ARGV[2])

-- If the key exists, the lock is still active (Redis TTL is authoritative).
if redis.call('EXISTS', lockKey) == 1 then
  return nil
end

-- Increment fencing counter (monotonic, never reset).
local nextFencing = redis.call('INCR', fenceKey)

-- Store the lock entry with native Redis TTL expiry.
local payload = cjson.encode({
  leaseToken = leaseToken,
  fencingToken = nextFencing,
})
redis.call('SET', lockKey, payload, 'PX', ttlMs)

return nextFencing
`;

/**
 * releaseIfOwner: atomically delete the lock key only when the stored lease
 * token matches and the lease has not expired. Returns 1 on success, 0 if
 * token mismatches or the key has expired / does not exist.
 *
 * KEYS[1] = lock key
 * ARGV[1] = expected lease token
 * ARGV[2] = current timestamp in milliseconds
 */
const RELEASE_SCRIPT = `
local lockKey = KEYS[1]
local expectedToken = ARGV[1]

-- Redis TTL is authoritative: if the key exists, the lock is still active.
local raw = redis.call('GET', lockKey)
if not raw then return 0 end

local decoded = cjson.decode(raw)
if decoded.leaseToken ~= expectedToken then return 0 end

redis.call('DEL', lockKey)
return 1
`;

/**
 * renewIfOwner: atomically extend the TTL of the lock key only when the stored
 * lease token matches and the lease has not expired. Returns 1 on success,
 * 0 if token mismatches or the lease has already expired.
 *
 * KEYS[1] = lock key
 * ARGV[1] = expected lease token
 * ARGV[2] = new TTL in milliseconds
 * ARGV[3] = current timestamp in milliseconds
 */
const RENEW_SCRIPT = `
local lockKey = KEYS[1]
local expectedToken = ARGV[1]
local newTtlMs = tonumber(ARGV[2])

-- Redis TTL is authoritative: if the key exists, the lock is still active.
local raw = redis.call('GET', lockKey)
if not raw then return 0 end

local decoded = cjson.decode(raw)
if decoded.leaseToken ~= expectedToken then return 0 end

-- Refresh the TTL (Redis handles expiry natively).
redis.call('SET', lockKey, cjson.encode(decoded), 'PX', newTtlMs)
return 1
`;

// ---------------------------------------------------------------------------
// RedisLockStore
// ---------------------------------------------------------------------------

export interface RedisLockStoreOptions {
  client: RedisEvalClient;
}

export class RedisLockStore implements LockStore {
  private readonly client: RedisEvalClient;

  constructor(options: RedisLockStoreOptions | RedisEvalClient) {
    // Backward-compatible: accept a bare client or a full options object.
    if ("eval" in options && typeof options.eval === "function") {
      this.client = options;
    } else {
      const opts = options as RedisLockStoreOptions;
      this.client = opts.client;
    }
  }

  async acquireSlot(params: AcquireSlotParams): Promise<number | null> {
    const { key, leaseToken, ttlMs } = params;
    const fenceKey = `${key}:fence`;

    const result = await this.client.eval(
      ACQUIRE_SCRIPT,
      2,         // number of KEYS
      key,       // KEYS[1]
      fenceKey,  // KEYS[2]
      leaseToken,
      ttlMs,
    );

    // ioredis returns null for nil, a number for RESP3, or a string "1" for RESP2.
    // Acquire failure (nil) must normalize to null; fencing tokens are positive integers only.
    if (result === null || result === undefined) return null;
    const n = typeof result === "number" ? result : typeof result === "string" ? Number(result) : NaN;
    return Number.isInteger(n) && n > 0 ? n : null;
  }

  async releaseIfOwner(key: string, expectedLeaseToken: string): Promise<boolean> {
    const result = await this.client.eval(
      RELEASE_SCRIPT,
      1, // KEYS
      key,
      expectedLeaseToken,
    );
    // Lua returns 1/0; ioredis returns number or string.
    return result === true || result === 1 || result === "1";
  }

  async renewIfOwner(params: RenewIfOwnerParams): Promise<boolean> {
    const { key, expectedLeaseToken, newTtlMs } = params;

    const result = await this.client.eval(
      RENEW_SCRIPT,
      1, // KEYS
      key,
      expectedLeaseToken,
      newTtlMs,
    );
    return result === true || result === 1 || result === "1";
  }
}
