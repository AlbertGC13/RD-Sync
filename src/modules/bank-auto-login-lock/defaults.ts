/**
 * Production wiring for AutoLoginLock backed by Redis.
 *
 * Reads `RD_SYNC_REDIS_URL` from the environment, creates a dedicated ioredis
 * connection with `lazyConnect: true` (socket deferred until first EVAL),
 * wraps it in `RedisLockStore` (atomic Lua CAS scripts), and passes it to
 * `createAutoLoginLock`.
 *
 * Exported as a globalThis-cached singleton (`defaultAutoLoginLock`) following
 * the project's env-switch singleton pattern (see `src/app/api/scrape-runs/defaults.ts`).
 *
 * **Laziness guarantee:** Two separate mechanisms keep startup cost zero:
 * 1. **Singleton resolution** — `getOrCreateDefaultLock()` is only called on
 *    first property access of `defaultAutoLoginLock`, not at module-import time.
 * 2. **Socket connection** — `lazyConnect: true` ensures ioredis does not open
 *    a TCP/TLS socket until the first `EVAL` command.  Even after the singleton
 *    is resolved, no Redis traffic occurs until the first lock operation.
 *
 * **Redis topology:** RD-Sync currently uses a single Redis endpoint from
 * `RD_SYNC_REDIS_URL`. Redis Cluster requires explicit hash tags so the lock
 * key and its `:fence` key share the same hash slot. Do not use this default
 * wiring with Redis Cluster until those keys are wrapped with a shared hash tag.
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
      lazyConnect: true;
    }) => RedisEvalClient;
  },
): AutoLoginLock | null {
  const redisUrl = env.RD_SYNC_REDIS_URL;
  if (!redisUrl) return null;

  const connectionOpts = buildRedisConnectionOptions(redisUrl);

  let client: RedisEvalClient;
  if (options?.redisClientFactory) {
    client = options.redisClientFactory({ ...connectionOpts, lazyConnect: true });
  } else {
    // lazyConnect defers the TCP/TLS handshake until the first command (EVAL).
    // The singleton itself is also deferred — see getOrCreateDefaultLock().
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Redis = require("ioredis") as new (opts: typeof connectionOpts & { lazyConnect: true }) => RedisEvalClient;
    client = new Redis({ ...connectionOpts, lazyConnect: true });
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
 * created lazily on first access — no code runs at module-import time.
 * When `RD_SYNC_REDIS_URL` is set, the ioredis client is constructed with
 * `lazyConnect: true`, so even after singleton resolution no Redis socket is
 * opened until the first lock command.
 */
export const defaultAutoLoginLock: AutoLoginLock | null = getOrCreateDefaultLock();
