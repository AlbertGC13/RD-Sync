/**
 * Production wiring for AutoLoginLock backed by Redis.
 *
 * Reads `RD_SYNC_REDIS_URL` from the environment, creates a dedicated ioredis
 * connection (lazy, connected on first EVAL), wraps it in `RedisLockStore`
 * (atomic Lua CAS scripts), and passes it to `createAutoLoginLock`.
 *
 * Exported as a globalThis-cached singleton (`defaultAutoLoginLock`) following
 * the project's env-switch singleton pattern (see `src/app/api/scrape-runs/defaults.ts`).
 *
 * **Redis Cluster note:** Lock keys use the pattern
 * `autologin:lock:{bankCode}:{expiredEventId}` — all segments are lowercase
 * alphanumeric. The fence key appends `:fence`. In Redis Cluster these are
 * hash-slot safe because the bankCode segment already constrains routing.
 * Single-instance Redis is the current production topology; if Cluster is
 * adopted, wrap keys in `{bankCode}` hash tags for guaranteed co-location.
 *
 * **Security:** The ioredis connection URL is read from env only. No
 * credentials are logged, exposed in API responses, or persisted.
 */

import { buildRedisConnectionOptions } from "../../worker/queues/bullmq-queue";
import { createAutoLoginLock, type AutoLoginLock } from "./index";
import { RedisLockStore, type RedisEvalClient } from "./redis-store";

// ---------------------------------------------------------------------------
// globalThis singleton — one lock per process, shared across module graphs
// ---------------------------------------------------------------------------

// Sentinel distinguishes "not yet initialised" from "null (disabled)".
const UNINITIALIZED = Symbol("uninitialized");

const globalRegistry = globalThis as typeof globalThis & {
  __rdSyncAutoLoginLock?: AutoLoginLock | null | typeof UNINITIALIZED;
};

/**
 * Creates a production `AutoLoginLock` backed by a Redis `LockStore`.
 *
 * Reads `RD_SYNC_REDIS_URL` from `process.env` at call time (not module-load
 * time), so the env var can be set dynamically in tests or dev workflows.
 *
 * @returns The lock, or `null` when `RD_SYNC_REDIS_URL` is not set (dev/test mode).
 */
export function createAutoLoginLockFromEnv(
  env: Record<string, string | undefined> = process.env,
  options?: {
    /** Override the Redis client constructor — inject a fake in tests. */
    redisClientFactory?: (opts: {
      host: string;
      port: number;
      password?: string;
      maxRetriesPerRequest: null;
    }) => RedisEvalClient;
  },
): AutoLoginLock | null {
  const redisUrl = env.RD_SYNC_REDIS_URL;
  if (!redisUrl) return null;

  const connectionOpts = buildRedisConnectionOptions(redisUrl);

  let client: RedisEvalClient;
  if (options?.redisClientFactory) {
    client = options.redisClientFactory(connectionOpts);
  } else {
    // ioredis connection is lazy — no socket is opened here.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Redis = require("ioredis") as new (opts: typeof connectionOpts) => RedisEvalClient;
    client = new Redis(connectionOpts);
  }

  const store = new RedisLockStore({ client });
  return createAutoLoginLock({ store });
}

// ---------------------------------------------------------------------------
// Lazy singleton — created once, cached for the process lifetime
// ---------------------------------------------------------------------------

function getOrCreateDefaultLock(): AutoLoginLock | null {
  if (globalRegistry.__rdSyncAutoLoginLock !== UNINITIALIZED) {
    return globalRegistry.__rdSyncAutoLoginLock ?? null;
  }

  const lock = createAutoLoginLockFromEnv();
  globalRegistry.__rdSyncAutoLoginLock = lock;
  return lock;
}

/**
 * Default AutoLoginLock singleton backed by Redis.
 *
 * `null` when `RD_SYNC_REDIS_URL` is not set (dev/test mode). The lock is
 * created lazily on first access — no Redis connection is opened at
 * module-import time.
 */
export const defaultAutoLoginLock: AutoLoginLock | null = getOrCreateDefaultLock();
