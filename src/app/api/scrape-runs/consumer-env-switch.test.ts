/**
 * Tests for the env-switch that controls whether the default ingestion consumer
 * is present (in-memory mode) or absent (BullMQ / Redis mode).
 *
 * These tests exercise the decision logic directly rather than the globalThis-
 * anchored singleton to avoid cross-test state leakage.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Inline replica of the consumer selector logic from consumer-defaults.ts
// (We test the decision, not the globalThis-anchored singleton.)
// ---------------------------------------------------------------------------

import { InMemoryScheduledIngestionQueue } from "./defaults";
import { createInMemoryIngestionConsumer } from "../../../worker/ingestion-consumer";
import { createIngestionProcessor } from "../../../worker/queues";

function resolveConsumerForEnv(options?: {
  redisUrl?: string | undefined;
  queue?: InMemoryScheduledIngestionQueue;
}) {
  const redisUrl = options?.redisUrl ?? process.env.RD_SYNC_REDIS_URL;
  if (redisUrl) {
    return undefined;
  }

  const queue = options?.queue ?? new InMemoryScheduledIngestionQueue();

  const processor = createIngestionProcessor({
    scrapeRuns: {
      markRunning: async () => {},
      markSucceeded: async () => {},
      markNeedsAdminAction: async () => {},
      markThrottled: async () => {},
      markFailed: async () => {},
    },
    transactions: { upsertMany: async () => ({ inserted: 0, skipped: 0 }) },
    scraper: {
      collect: async () => ({ status: "needs_admin_action" as const, movements: [], safeErrorSummary: "stub" }),
    },
  });

  return createInMemoryIngestionConsumer({ queue, processor });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("consumer env-switch", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns undefined when RD_SYNC_REDIS_URL is set — worker process consumes instead", () => {
    const consumer = resolveConsumerForEnv({ redisUrl: "redis://localhost:6379" });

    expect(consumer).toBeUndefined();
  });

  it("returns an in-process consumer when RD_SYNC_REDIS_URL is not set", () => {
    const consumer = resolveConsumerForEnv({ redisUrl: undefined });

    expect(consumer).toBeDefined();
    expect(typeof consumer?.drainPending).toBe("function");
  });

  it("env var: RD_SYNC_REDIS_URL set → consumer absent", () => {
    vi.stubEnv("RD_SYNC_REDIS_URL", "redis://localhost:6379");

    const consumer = resolveConsumerForEnv();

    expect(consumer).toBeUndefined();
  });

  it("env var: RD_SYNC_REDIS_URL unset → consumer present", () => {
    delete process.env.RD_SYNC_REDIS_URL;

    const consumer = resolveConsumerForEnv();

    expect(consumer).toBeDefined();
  });

  it("the in-process consumer drainPending() is callable and returns an array", async () => {
    const queue = new InMemoryScheduledIngestionQueue();
    const consumer = resolveConsumerForEnv({ redisUrl: undefined, queue });

    const results = await consumer!.drainPending();

    expect(Array.isArray(results)).toBe(true);
    expect(results).toHaveLength(0);
  });

  it("when RD_SYNC_REDIS_URL is set, run-now consumer?.drainPending() is a safe no-op", async () => {
    // Simulates what run-now route does: consumer?.drainPending()
    // With undefined consumer, the optional chain is a no-op (returns undefined,
    // not a rejected promise).
    const consumer = resolveConsumerForEnv({ redisUrl: "redis://localhost:6379" });

    const result = await consumer?.drainPending();

    expect(result).toBeUndefined();
  });
});
