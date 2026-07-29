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
 * **Module evaluation:** `defaultAutoLoginLock` is resolved at module evaluation
 * time (import).  When `RD_SYNC_REDIS_URL` is set, the singleton is non-null
 * immediately — no lazy "first property access" gate exists.
 *
 * **Socket connection:** `lazyConnect: true` ensures ioredis does not open
 * a TCP/TLS socket until the first `EVAL` command.  Even after the singleton
 * is resolved, no Redis traffic occurs until the first lock operation.
 *
 * **Redis topology:** RD-Sync currently uses a single Redis endpoint from
 * `RD_SYNC_REDIS_URL`. Redis Cluster requires explicit hash tags so the lock
 * key and its `:fence` key share the same hash slot. Do not use this default
 * wiring with Redis Cluster until those keys are wrapped with a shared hash tag.
 *
 * **Security:** The ioredis connection URL is read from env only. No
 * credentials are logged, exposed in API responses, or persisted.
 */

import { createRequire } from "node:module";

import { buildRedisConnectionOptions } from "../../worker/queues/bullmq-queue";
import { createAutoLoginLock, type AutoLoginLock } from "./index";
import { RedisLockStore, type RedisEvalClient } from "./redis-store";

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Redis fail-closed policy — named constants for lock-specific overrides
//
// BullMQ sets maxRetriesPerRequest: null (infinite) for queue connections.
// Lock connections override this with bounded retries and timeouts so
// Redis outages fail closed instead of hanging indefinitely.
// ---------------------------------------------------------------------------

const LOCK_MAX_RETRIES = 3;
const LOCK_CONNECT_TIMEOUT_MS = 5_000;
const LOCK_COMMAND_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// globalThis singleton — one lock per process, shared across module graphs
// ---------------------------------------------------------------------------

const globalRegistry = globalThis as typeof globalThis & {
  __rdSyncAutoLoginLock?: AutoLoginLock | null;
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
      maxRetriesPerRequest: number;
      connectTimeout: number;
      commandTimeout: number;
      lazyConnect: true;
    }) => RedisEvalClient;
  },
): AutoLoginLock | null {
  const redisUrl = env.RD_SYNC_REDIS_URL;
  if (!redisUrl) return null;

  const connectionOpts = buildRedisConnectionOptions(redisUrl);

  // Lock-specific options: override BullMQ's maxRetriesPerRequest:null so lock
  // commands fail closed (bounded retries + timeout) rather than waiting
  // indefinitely during a Redis outage.  lazyConnect keeps the socket deferred
  // until the first EVAL command.
  const lockConnectionOpts = {
    ...connectionOpts,
    maxRetriesPerRequest: LOCK_MAX_RETRIES,
    connectTimeout: LOCK_CONNECT_TIMEOUT_MS,
    commandTimeout: LOCK_COMMAND_TIMEOUT_MS,
    lazyConnect: true as const,
  };

  let client: RedisEvalClient;
  if (options?.redisClientFactory) {
    client = options.redisClientFactory(lockConnectionOpts);
  } else {
    const Redis = require("ioredis") as new (opts: typeof lockConnectionOpts) => RedisEvalClient;
    client = new Redis(lockConnectionOpts);
  }

  const store = new RedisLockStore({ client });
  return createAutoLoginLock({ store });
}

// ---------------------------------------------------------------------------
// Module-evaluation singleton — resolved once at import, cached for the
// process lifetime.  The Redis socket itself stays lazy (lazyConnect: true).
// ---------------------------------------------------------------------------

function getOrCreateDefaultLock(): AutoLoginLock | null {
  // Property-presence check: if the slot exists on globalThis, it holds either
  // a lock instance or null (disabled).  An absent slot means "not yet created".
  if ("__rdSyncAutoLoginLock" in globalRegistry) {
    return globalRegistry.__rdSyncAutoLoginLock ?? null;
  }

  const lock = createAutoLoginLockFromEnv();
  globalRegistry.__rdSyncAutoLoginLock = lock;
  return lock;
}

/**
 * Default AutoLoginLock singleton backed by Redis.
 *
 * `null` when `RD_SYNC_REDIS_URL` is not set (dev/test mode).  Resolved at
 * module evaluation time (import).  When `RD_SYNC_REDIS_URL` is set, the
 * ioredis client is constructed with `lazyConnect: true`, so even after
 * singleton resolution no Redis socket is opened until the first lock command.
 */
export const defaultAutoLoginLock: AutoLoginLock | null = getOrCreateDefaultLock();
