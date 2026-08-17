import { afterEach, describe, expect, it } from "vitest";

import { createBullmqIngestionQueue, buildRedisConnectionOptions, type BullmqQueuePort } from "./bullmq-queue";
import type { IngestionJobData } from "./index";
import { createIngestionQueueOptions } from "./index";

// ---------------------------------------------------------------------------
// Fake BullMQ Queue
// ---------------------------------------------------------------------------

interface QueueCall {
  name: string;
  data: IngestionJobData;
  options: unknown;
}

class FakeBullmqQueue implements BullmqQueuePort {
  readonly calls: QueueCall[] = [];

  async add(name: string, data: IngestionJobData, options: unknown): Promise<void> {
    this.calls.push({ name, data, options });
  }
}

const jobData: IngestionJobData = {
  runId: "run-bullmq-1",
  bankId: "popular",
  accountFingerprint: "acct-main",
  authentication: {
    version: 1,
    attemptId: "auth-attempt-v1:0802674dadacdf86fce600258dabacdfd1e73a48953678879dd1fdacf2efa94f",
  },
};

// ---------------------------------------------------------------------------
// buildRedisConnectionOptions
// ---------------------------------------------------------------------------

describe("buildRedisConnectionOptions", () => {
  it("parses a simple redis:// URL", () => {
    const opts = buildRedisConnectionOptions("redis://localhost:6379");
    expect(opts).toEqual({
      host: "localhost",
      port: 6379,
      maxRetriesPerRequest: null,
    });
  });

  it("parses a URL with password", () => {
    const opts = buildRedisConnectionOptions("redis://:s3cr3t@redis.example.com:6380");
    expect(opts).toMatchObject({
      host: "redis.example.com",
      port: 6380,
      password: "s3cr3t",
      maxRetriesPerRequest: null,
    });
  });

  it("defaults port to 6379 when omitted", () => {
    const opts = buildRedisConnectionOptions("redis://localhost");
    expect(opts.port).toBe(6379);
    expect(opts.maxRetriesPerRequest).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// createBullmqIngestionQueue — delegates to injected fake
// ---------------------------------------------------------------------------

describe("createBullmqIngestionQueue", () => {
  it("delegates add() to the injected fake queue with the correct name, data, and options", async () => {
    const fakeQueue = new FakeBullmqQueue();

    const queue = createBullmqIngestionQueue({
      queueFactory: () => fakeQueue,
    });

    const options = createIngestionQueueOptions(jobData.runId);
    await queue.add("bank-transaction-ingestion", jobData, options);

    expect(fakeQueue.calls).toHaveLength(1);
    expect(fakeQueue.calls[0]).toEqual({
      name: "bank-transaction-ingestion",
      data: jobData,
      options,
    });
    expect(fakeQueue.calls[0]?.data).toBe(jobData);
  });

  it("passes the BullMQ options including jobId=runId, attempts=3, exponential backoff", async () => {
    const fakeQueue = new FakeBullmqQueue();
    const queue = createBullmqIngestionQueue({ queueFactory: () => fakeQueue });
    const options = createIngestionQueueOptions("run-42");

    await queue.add("bank-transaction-ingestion", { ...jobData, runId: "run-42" }, options);

    expect(fakeQueue.calls[0].options).toMatchObject({
      jobId: "run-42",
      attempts: 3,
      backoff: { type: "exponential", delay: 30_000 },
      removeOnComplete: 100,
      removeOnFail: 250,
    });
  });

  it("creates the inner queue lazily — queueFactory is not called until the first add()", () => {
    let created = false;
    const fakeQueue = new FakeBullmqQueue();

    const queue = createBullmqIngestionQueue({
      queueFactory: () => {
        created = true;
        return fakeQueue;
      },
    });

    expect(created).toBe(false);

    void queue.add("bank-transaction-ingestion", jobData, createIngestionQueueOptions(jobData.runId));

    expect(created).toBe(true);
  });

  it("reuses the same inner queue on subsequent add() calls", async () => {
    let callCount = 0;
    const fakeQueue = new FakeBullmqQueue();

    const queue = createBullmqIngestionQueue({
      queueFactory: () => {
        callCount++;
        return fakeQueue;
      },
    });

    await queue.add("bank-transaction-ingestion", jobData, createIngestionQueueOptions(jobData.runId));
    await queue.add("bank-transaction-ingestion", jobData, createIngestionQueueOptions(jobData.runId));

    expect(callCount).toBe(1);
    expect(fakeQueue.calls).toHaveLength(2);
  });

  afterEach(() => {
    // No env vars to clean up in these tests — env-switch tests live in their
    // own describe block below.
  });
});
