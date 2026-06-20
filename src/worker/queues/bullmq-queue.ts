import type { JobsOptions, Queue } from "bullmq";
import type { IngestionJobData, QueueLike } from "./index";

// ---------------------------------------------------------------------------
// Connection helper
// ---------------------------------------------------------------------------

/**
 * Build an ioredis-compatible connection options object that satisfies
 * BullMQ's requirement for `maxRetriesPerRequest: null` on blocking
 * connections.
 *
 * We accept a Redis URL string and parse it into the flat options object that
 * ioredis understands (and that BullMQ passes through as-is).  Connection is
 * LAZY — this function just returns the options; no socket is opened here.
 */
export function buildRedisConnectionOptions(redisUrl: string): {
  host: string;
  port: number;
  password?: string;
  maxRetriesPerRequest: null;
} {
  const parsed = new URL(redisUrl);
  return {
    host: parsed.hostname || "localhost",
    port: parsed.port ? parseInt(parsed.port, 10) : 6379,
    ...(parsed.password ? { password: decodeURIComponent(parsed.password) } : {}),
    maxRetriesPerRequest: null,
  };
}

// ---------------------------------------------------------------------------
// BullMQ queue adapter
// ---------------------------------------------------------------------------

/**
 * The subset of bullmq.Queue that the adapter needs.  Using a structural
 * interface here means unit tests can inject a plain fake without importing
 * BullMQ at all.
 */
export interface BullmqQueuePort {
  add(name: string, data: IngestionJobData, options?: JobsOptions): Promise<unknown>;
}

/**
 * Wraps a BullMQ Queue (or any BullmqQueuePort-compatible fake) in the
 * QueueLike interface so the rest of the codebase stays queue-agnostic.
 *
 * The `connection` parameter is only used when `queueFactory` is omitted
 * (i.e. in production).  In tests, pass a `queueFactory` that returns a fake.
 */
export function createBullmqIngestionQueue(options: {
  /** ioredis-compatible connection options.  Unused when `queueFactory` is provided. */
  connection?: { host: string; port: number; password?: string; maxRetriesPerRequest: null };
  /** Override the BullMQ Queue constructor — inject a fake in tests. */
  queueFactory?: (name: string, opts: { connection: unknown }) => BullmqQueuePort;
}): QueueLike {
  let inner: BullmqQueuePort | null = null;

  function getQueue(): BullmqQueuePort {
    if (inner) return inner;

    if (options.queueFactory) {
      inner = options.queueFactory("bank-transaction-ingestion", {
        connection: options.connection ?? {},
      });
      return inner;
    }

    // Production path — import BullMQ dynamically so the module can be imported
    // in environments where BullMQ is installed but Redis is not running, without
    // opening a connection at import time.
    //
    // We use a synchronous require-style dynamic import here to avoid making
    // the public add() method async-before-async.  BullMQ is always available
    // (it is in package.json dependencies) so the require will never throw.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Queue } = require("bullmq") as { Queue: new (name: string, opts: { connection: unknown }) => Queue };
    inner = new Queue("bank-transaction-ingestion", {
      connection: options.connection,
    }) as unknown as BullmqQueuePort;

    return inner;
  }

  return {
    async add(name: string, data: IngestionJobData, jobOptions: JobsOptions): Promise<unknown> {
      return getQueue().add(name, data, jobOptions);
    },
  };
}
