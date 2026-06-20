/**
 * Real-Redis integration test: enqueue a job → worker drains it → processor runs.
 *
 * GATED: This test suite is SKIPPED when RD_SYNC_TEST_REDIS_URL is not set,
 * mirroring the Prisma contract tests gated on RD_SYNC_TEST_DATABASE_URL.
 * Run with a live Redis:
 *
 *   RD_SYNC_TEST_REDIS_URL=redis://localhost:6379 pnpm test
 *
 * Default `pnpm test` (without Redis) stays green — all tests in this file are
 * skipped.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildRedisConnectionOptions } from "./queues/bullmq-queue";

const TEST_REDIS_URL = process.env.RD_SYNC_TEST_REDIS_URL;
const RUN_INTEGRATION = Boolean(TEST_REDIS_URL);

describe.skipIf(!RUN_INTEGRATION)("ingestion-worker integration (requires RD_SYNC_TEST_REDIS_URL)", () => {
  // Use dynamic imports inside beforeAll so bullmq is not loaded (and does not
  // attempt a connection) when the suite is skipped.

  let Queue: typeof import("bullmq").Queue;
  let Worker: typeof import("bullmq").Worker;
  let testQueue: import("bullmq").Queue;
  let testWorker: import("bullmq").Worker | undefined;

  // Use plain connection options (not ioredis instances) to avoid the
  // ioredis version mismatch between bullmq's bundled peer and our own.
  const connectionOpts = buildRedisConnectionOptions(TEST_REDIS_URL ?? "redis://localhost:6379");

  const QUEUE_NAME = "bank-transaction-ingestion-integration-test";

  beforeAll(async () => {
    const bullmq = await import("bullmq");
    Queue = bullmq.Queue;
    Worker = bullmq.Worker;

    testQueue = new Queue(QUEUE_NAME, { connection: connectionOpts });

    // Drain any leftover jobs from a previous interrupted test run.
    await testQueue.drain();
  });

  afterAll(async () => {
    await testWorker?.close();
    await testQueue?.close();
  });

  it("enqueued job is processed by the worker and the processor result is returned", async () => {
    const processed: Array<{ runId: string; result: { status: string } }> = [];

    const fakeProcessor = async (job: { data: { runId: string; bankId: string; accountFingerprint: string } }) => {
      const result = { status: "succeeded" as const, inserted: 1, skipped: 0 };
      processed.push({ runId: job.data.runId, result });
      return result;
    };

    testWorker = new Worker(
      QUEUE_NAME,
      async (job) => {
        return fakeProcessor(job as { data: { runId: string; bankId: string; accountFingerprint: string } });
      },
      {
        connection: connectionOpts,
        concurrency: 1,
      },
    );

    // Wait for the worker to be ready.
    await new Promise<void>((resolve) => testWorker!.on("ready", resolve));

    const runId = `integration-test-${Date.now()}`;
    await testQueue.add(
      QUEUE_NAME,
      { runId, bankId: "popular", accountFingerprint: "acct-integration" },
      { jobId: runId, attempts: 3, backoff: { type: "exponential", delay: 1000 } },
    );

    // Wait for the job to be processed (up to 5 seconds).
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for job to be processed")), 5000);
      testWorker!.on("completed", () => {
        clearTimeout(timeout);
        resolve();
      });
      testWorker!.on("failed", (_job, err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    expect(processed).toHaveLength(1);
    expect(processed[0].runId).toBe(runId);
    expect(processed[0].result.status).toBe("succeeded");
  });
});
