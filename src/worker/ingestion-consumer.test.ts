import { describe, expect, it, vi } from "vitest";

import { InMemoryAuditSink } from "../modules/audit";
import { InMemoryTransactionRepository } from "../modules/transactions";
import {
  createIngestionProcessor,
  type IngestionJobData,
  type IngestionScraper,
  type ScrapeRunStatus,
} from "./queues";
import { createInMemoryIngestionConsumer } from "./ingestion-consumer";
import { InMemoryScheduledIngestionQueue } from "../app/api/scrape-runs/defaults";
import { AuthenticatedIngestionRetryError } from "./authenticated-ingestion-delivery";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeScrapeRunRepository {
  private readonly records: Map<string, { status: ScrapeRunStatus; safeErrorSummary?: string }> = new Map();

  async createQueued(id: string): Promise<void> {
    this.records.set(id, { status: "queued" });
  }

  async markRunning(runId: string): Promise<void> {
    this.records.set(runId, { status: "running" });
  }

  async markSucceeded(runId: string): Promise<void> {
    this.records.set(runId, { status: "succeeded" });
  }

  async markNeedsAdminAction(runId: string, safeErrorSummary: string): Promise<void> {
    this.records.set(runId, { status: "needs_admin_action", safeErrorSummary });
  }

  async markThrottled(runId: string, safeErrorSummary: string): Promise<void> {
    this.records.set(runId, { status: "throttled", safeErrorSummary });
  }

  async markFailed(runId: string, safeErrorSummary: string): Promise<void> {
    this.records.set(runId, { status: "failed", safeErrorSummary });
  }

  statusOf(runId: string): ScrapeRunStatus | undefined {
    return this.records.get(runId)?.status;
  }
}

class FakeAdminAlertSink {
  readonly events: Array<{
    runId: string;
    bankId: string;
    status: "failed" | "needs_admin_action";
    safeErrorSummary: string;
  }> = [];

  async notifyIngestionAttention(event: {
    runId: string;
    bankId: string;
    status: "failed" | "needs_admin_action";
    safeErrorSummary: string;
  }): Promise<void> {
    this.events.push(event);
  }

  async notifySessionAttention(): Promise<void> {
    // no-op in tests that don't exercise session alerts
  }
}

function makeFixtureScraper(): IngestionScraper {
  return {
    collect: async () => ({
      status: "collected" as const,
      movements: [
        {
          bankId: "popular",
          accountFingerprint: "popular-test",
          postedAt: "2026-06-07T00:00:00-04:00",
          amount: "1500.00",
          currency: "DOP",
          direction: "credit" as const,
          reference: "REF-001",
          concept: "Test deposit",
          originator: null,
        },
      ],
    }),
  };
}

function makeJob(runId: string): { data: IngestionJobData } {
  return { data: { runId, bankId: "popular", accountFingerprint: "popular-test" } };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createInMemoryIngestionConsumer — drainPending", () => {
  it("processes a queued job end-to-end: run transitions queued→running→succeeded, transactions upserted, queue empty", async () => {
    const queue = new InMemoryScheduledIngestionQueue();
    const scrapeRuns = new FakeScrapeRunRepository();
    const transactions = new InMemoryTransactionRepository();
    const auditSink = new InMemoryAuditSink();
    const adminAlerts = new FakeAdminAlertSink();

    const processor = createIngestionProcessor({
      scrapeRuns,
      transactions,
      scraper: makeFixtureScraper(),
      auditSink,
      adminAlerts,
    });

    const consumer = createInMemoryIngestionConsumer({ queue, processor });

    // Enqueue a job
    await queue.add("bank-transaction-ingestion", makeJob("run-abc").data, { jobId: "run-abc" });
    expect(queue.jobs).toHaveLength(1);

    const results = await consumer.drainPending();

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ status: "succeeded", inserted: 1, skipped: 0 });

    // Queue drained
    expect(queue.jobs).toHaveLength(0);

    // Run transitioned to succeeded
    expect(scrapeRuns.statusOf("run-abc")).toBe("succeeded");

    // Transactions upserted
    const txs = await transactions.list({});
    expect(txs.length).toBeGreaterThan(0);

    // Audit events recorded
    const events = await auditSink.list();
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.action === "scrape_run.started")).toBe(true);
    expect(events.some((e) => e.action === "scrape_run.succeeded")).toBe(true);
  });

  it("a processor failure on one job does not prevent the next job from processing", async () => {
    const queue = new InMemoryScheduledIngestionQueue();
    const scrapeRuns = new FakeScrapeRunRepository();

    let callCount = 0;
    const flakyProcessor = async (job: { data: IngestionJobData }) => {
      callCount++;
      if (callCount === 1) throw new Error("Simulated processor crash");
      return createIngestionProcessor({
        scrapeRuns,
        transactions: { upsertMany: async () => ({ inserted: 0, skipped: 0 }) },
        scraper: makeFixtureScraper(),
      })(job);
    };

    const consumer = createInMemoryIngestionConsumer({ queue, processor: flakyProcessor });

    await queue.add("bank-transaction-ingestion", makeJob("run-1").data, { jobId: "run-1" });
    await queue.add("bank-transaction-ingestion", makeJob("run-2").data, { jobId: "run-2" });

    const results = await consumer.drainPending();

    // Both jobs consumed from queue
    expect(queue.jobs).toHaveLength(0);

    // Two results — first is an error wrapper, second succeeded
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ error: expect.any(Error) });
    expect(results[1]).toMatchObject({ status: "succeeded" });
  });

  it("honest default (no dev preview): drain results in needs_admin_action, no transactions inserted, admin alert notified", async () => {
    const queue = new InMemoryScheduledIngestionQueue();
    const scrapeRuns = new FakeScrapeRunRepository();
    const transactions = { upsertMany: vi.fn(async () => ({ inserted: 0, skipped: 0 })) };
    const adminAlerts = new FakeAdminAlertSink();

    const noNavScraper: IngestionScraper = {
      collect: async () => ({
        status: "needs_admin_action" as const,
        movements: [],
        safeErrorSummary: "Bank portal navigation not configured yet",
      }),
    };

    const processor = createIngestionProcessor({
      scrapeRuns,
      transactions,
      scraper: noNavScraper,
      adminAlerts,
    });

    const consumer = createInMemoryIngestionConsumer({ queue, processor });

    await queue.add("bank-transaction-ingestion", makeJob("run-honest").data, { jobId: "run-honest" });

    const results = await consumer.drainPending();

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ status: "needs_admin_action", inserted: 0, skipped: 0 });

    // No transactions inserted
    expect(transactions.upsertMany).not.toHaveBeenCalled();

    // Admin alert notified
    expect(adminAlerts.events).toHaveLength(1);
    expect(adminAlerts.events[0]).toMatchObject({
      runId: "run-honest",
      status: "needs_admin_action",
      safeErrorSummary: "Bank portal navigation not configured yet",
    });
  });

  it("returns an empty array when there are no pending jobs", async () => {
    const queue = new InMemoryScheduledIngestionQueue();
    const processor = createIngestionProcessor({
      scrapeRuns: new FakeScrapeRunRepository(),
      transactions: { upsertMany: async () => ({ inserted: 0, skipped: 0 }) },
      scraper: makeFixtureScraper(),
    });

    const consumer = createInMemoryIngestionConsumer({ queue, processor });
    const results = await consumer.drainPending();

    expect(results).toEqual([]);
  });

  it("retries a genuine authenticated delivery with frozen attempt metadata and stops at its terminal result", async () => {
    const queue = new InMemoryScheduledIngestionQueue();
    const data = { ...makeJob("run-retry").data, authentication: { version: 1 as const, attemptId: "attempt-retry" } };
    const calls: Array<{ data: unknown; attemptsMade: number; maxAttempts: number; frozen: boolean }> = [];
    const onJobError = vi.fn(async () => {});
    const processor = vi.fn(async (job) => {
      calls.push({
        data: job.data,
        attemptsMade: job.deliveryAttempt!.attemptsMade,
        maxAttempts: job.deliveryAttempt!.maxAttempts,
        frozen: Object.isFrozen(job.deliveryAttempt!),
      });
      if (calls.length < 3) throw new AuthenticatedIngestionRetryError("retry_delivery");
      return { status: "needs_admin_action" as const, inserted: 0, skipped: 0 };
    });
    await queue.add("bank-transaction-ingestion", data, { jobId: "run-retry", attempts: 3 });
    const results = await createInMemoryIngestionConsumer({ queue, processor, onJobError }).drainPending();
    expect(results).toEqual([{ status: "needs_admin_action", inserted: 0, skipped: 0 }]);
    expect(calls).toEqual([
      { data, attemptsMade: 0, maxAttempts: 3, frozen: true },
      { data, attemptsMade: 1, maxAttempts: 3, frozen: true },
      { data, attemptsMade: 2, maxAttempts: 3, frozen: true },
    ]);
    expect(onJobError).not.toHaveBeenCalled();
    expect(queue.jobs).toEqual([]);
  });

  it("contains unknown failures after their final attempt and continues draining", async () => {
    const queue = new InMemoryScheduledIngestionQueue();
    const onJobError = vi.fn(async () => {});
    const processor = vi.fn(async (job) => {
      if (job.data.runId === "run-fails") throw new Error("raw internal failure");
      return { status: "succeeded" as const, inserted: 1, skipped: 0 };
    });
    await queue.add("bank-transaction-ingestion", makeJob("run-fails").data, { jobId: "run-fails", attempts: 3 });
    await queue.add("bank-transaction-ingestion", makeJob("run-next").data, { jobId: "run-next", attempts: 1 });
    const results = await createInMemoryIngestionConsumer({ queue, processor, onJobError }).drainPending();
    expect(processor).toHaveBeenCalledTimes(4);
    expect(onJobError).toHaveBeenCalledTimes(1);
    expect(results).toEqual([
      { error: expect.objectContaining({ message: "In-memory ingestion job failed." }) },
      { status: "succeeded", inserted: 1, skipped: 0 },
    ]);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN])("fails closed before processing malformed stored attempts %p", async (attempts) => {
    const queue = new InMemoryScheduledIngestionQueue();
    const processor = vi.fn(async (job: { deliveryAttempt?: unknown }) => {
      void job;
      return { status: "succeeded" as const, inserted: 0, skipped: 0 };
    });
    const onJobError = vi.fn(async () => { throw new Error("recovery failure"); });
    await queue.add("bank-transaction-ingestion", makeJob("run-malformed").data, { jobId: "run-malformed", attempts });
    const results = await createInMemoryIngestionConsumer({ queue, processor, onJobError }).drainPending();
    expect(processor).not.toHaveBeenCalled();
    expect(onJobError).toHaveBeenCalledOnce();
    expect(results).toEqual([{ error: expect.objectContaining({ message: "In-memory ingestion job failed." }) }]);
  });

  it("uses the documented one-attempt default when stored options are undefined", async () => {
    const queue = new InMemoryScheduledIngestionQueue();
    const processor = vi.fn(async (job: { deliveryAttempt?: unknown }) => {
      void job;
      return { status: "succeeded" as const, inserted: 0, skipped: 0 };
    });
    const onJobError = vi.fn(async () => {});
    queue.jobs.push({ name: "bank-transaction-ingestion", data: makeJob("run-default-options").data, options: undefined } as never);
    const results = await createInMemoryIngestionConsumer({ queue, processor, onJobError }).drainPending();
    expect(processor).toHaveBeenCalledOnce();
    expect(processor.mock.calls[0]?.[0].deliveryAttempt).toEqual({ attemptsMade: 0, maxAttempts: 1 });
    expect(onJobError).not.toHaveBeenCalled();
    expect(results).toEqual([{ status: "succeeded", inserted: 0, skipped: 0 }]);
  });

  it("fails closed without invoking getters for hostile stored options", async () => {
    const getter = vi.fn(() => 1);
    const hidden = Object.defineProperty({}, "attempts", { value: 1, enumerable: false });
    const inherited = Object.create({ attempts: 1 });
    const accessor = Object.defineProperty({}, "attempts", { get: getter, enumerable: true });
    const symbol = { attempts: 1, [Symbol("extra")]: true };
    const extra = { attempts: 1, extra: true };
    const proxy = new Proxy({ attempts: 1 }, { getPrototypeOf: () => { throw new Error("raw proxy sentinel"); } });

    for (const [index, options] of [hidden, inherited, accessor, symbol, extra, proxy].entries()) {
      const queue = new InMemoryScheduledIngestionQueue();
      const processor = vi.fn(async () => ({ status: "succeeded" as const, inserted: 0, skipped: 0 }));
      const onJobError = vi.fn(async () => {});
      queue.jobs.push({ name: "bank-transaction-ingestion", data: makeJob(`run-hostile-${index}`).data, options } as never);

      await expect(createInMemoryIngestionConsumer({ queue, processor, onJobError }).drainPending()).resolves.toEqual([
        { error: expect.objectContaining({ message: "In-memory ingestion job failed." }) },
      ]);
      expect(processor).not.toHaveBeenCalled();
      expect(onJobError).toHaveBeenCalledOnce();
    }

    expect(getter).not.toHaveBeenCalled();
  });

  it("accepts a null-prototype options record with only an enumerable data attempts key", async () => {
    const queue = new InMemoryScheduledIngestionQueue();
    const processor = vi.fn(async (job) => {
      if (job.deliveryAttempt!.attemptsMade === 0) throw new AuthenticatedIngestionRetryError("retry_delivery");
      return { status: "succeeded" as const, inserted: 0, skipped: 0 };
    });
    const options = Object.assign(Object.create(null), { attempts: 2 });
    const data = Object.freeze(makeJob("run-null-options").data);
    Object.freeze(options);
    queue.jobs.push({ name: "bank-transaction-ingestion", data, options } as never);

    await expect(createInMemoryIngestionConsumer({ queue, processor }).drainPending()).resolves.toEqual([
      { status: "succeeded", inserted: 0, skipped: 0 },
    ]);
    expect(processor).toHaveBeenCalledTimes(2);
    expect(options).toEqual({ attempts: 2 });
  });
});
