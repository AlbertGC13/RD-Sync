import { describe, expect, it } from "vitest";

import {
  createIngestionProcessor,
  createIngestionQueueOptions,
  scheduleIngestionJob,
  type IngestionJobData,
  type ScrapeRunStatus,
} from "./index";
import type { BankMovement } from "../../modules/transactions";

const jobData: IngestionJobData = {
  runId: "run-1",
  bankId: "popular",
  accountFingerprint: "acct-main",
};

describe("ingestion processor", () => {
  it("marks a run succeeded with inserted and skipped transaction counts", async () => {
    const movements: BankMovement[] = [
      {
        bankId: "popular",
        accountFingerprint: "acct-main",
        postedAt: "2026-06-07T13:45:00.000Z",
        amount: "1500.50",
        currency: "DOP",
        direction: "credit",
        reference: "REF-123",
      },
      {
        bankId: "popular",
        accountFingerprint: "acct-main",
        postedAt: "2026-06-07T14:00:00.000Z",
        amount: "1500.50",
        currency: "DOP",
        direction: "credit",
        reference: "REF-123",
      },
    ];
    const scrapeRuns = new FakeScrapeRunRepository();
    const transactions = new FakeTransactionRepository({ inserted: 1, skipped: 1 });
    const processor = createIngestionProcessor({
      scrapeRuns,
      transactions,
      scraper: { collect: async () => ({ status: "collected", movements }) },
    });

    const result = await processor({ data: jobData });

    expect(result).toEqual({ status: "succeeded", inserted: 1, skipped: 1 });
    expect(scrapeRuns.transitions).toEqual([
      { runId: "run-1", status: "running" },
      { runId: "run-1", status: "succeeded", insertedCount: 1, skippedCount: 1 },
    ]);
    expect(transactions.received).toHaveLength(2);
    expect(transactions.received.map((record) => record.scrapeRunId)).toEqual(["run-1", "run-1"]);
    expect(new Set(transactions.received.map((record) => record.sourceHash)).size).toBe(2);
  });

  it("pauses the run for admin action when the scraper reports MFA", async () => {
    const scrapeRuns = new FakeScrapeRunRepository();
    const transactions = new FakeTransactionRepository({ inserted: 0, skipped: 0 });
    const adminAlerts = new FakeAdminAlertSink();
    const processor = createIngestionProcessor({
      scrapeRuns,
      transactions,
      adminAlerts,
      scraper: {
        collect: async () => ({
          status: "needs_admin_action",
          movements: [],
          safeErrorSummary: "Bank session requires admin MFA action",
        }),
      },
    });

    const result = await processor({ data: jobData });

    expect(result).toEqual({ status: "needs_admin_action", inserted: 0, skipped: 0 });
    expect(scrapeRuns.transitions).toEqual([
      { runId: "run-1", status: "running" },
      {
        runId: "run-1",
        status: "needs_admin_action",
        safeErrorSummary: "Bank session requires admin MFA action",
      },
    ]);
    expect(transactions.received).toEqual([]);
    expect(adminAlerts.events).toEqual([
      {
        runId: "run-1",
        bankId: "popular",
        status: "needs_admin_action",
        safeErrorSummary: "Bank session requires admin MFA action",
      },
    ]);
  });

  it("records a safe failure summary without leaking secrets", async () => {
    const scrapeRuns = new FakeScrapeRunRepository();
    const adminAlerts = new FakeAdminAlertSink();
    const processor = createIngestionProcessor({
      scrapeRuns,
      adminAlerts,
      transactions: new FakeTransactionRepository({ inserted: 0, skipped: 0 }),
      scraper: {
        collect: async () => {
          throw new Error("selector missing token=secret password=abc account 0012345678901");
        },
      },
    });

    const result = await processor({ data: jobData });

    expect(result).toEqual({ status: "failed", inserted: 0, skipped: 0 });
    expect(scrapeRuns.transitions).toEqual([
      { runId: "run-1", status: "running" },
      {
        runId: "run-1",
        status: "failed",
        safeErrorSummary: "selector missing [REDACTED] [REDACTED] account [REDACTED_ACCOUNT]",
      },
    ]);
    expect(adminAlerts.events).toEqual([
      {
        runId: "run-1",
        bankId: "popular",
        status: "failed",
        safeErrorSummary: "selector missing [REDACTED] [REDACTED] account [REDACTED_ACCOUNT]",
      },
    ]);
  });
});

describe("BullMQ ingestion scheduling", () => {
  it("uses stable job ids and retry/backoff options", async () => {
    const queue = new FakeQueue();

    await scheduleIngestionJob(queue, jobData);

    expect(queue.addCalls).toEqual([
      {
        name: "bank-transaction-ingestion",
        data: jobData,
        options: {
          jobId: "run-1",
          attempts: 3,
          backoff: { type: "exponential", delay: 30_000 },
          removeOnComplete: 100,
          removeOnFail: 250,
        },
      },
    ]);
    expect(createIngestionQueueOptions("run-2").jobId).toBe("run-2");
  });
});

class FakeScrapeRunRepository {
  readonly transitions: Array<{
    runId: string;
    status: ScrapeRunStatus;
    insertedCount?: number;
    skippedCount?: number;
    safeErrorSummary?: string;
  }> = [];

  async markRunning(runId: string): Promise<void> {
    this.transitions.push({ runId, status: "running" });
  }

  async markSucceeded(runId: string, counts: { insertedCount: number; skippedCount: number }): Promise<void> {
    this.transitions.push({ runId, status: "succeeded", ...counts });
  }

  async markNeedsAdminAction(runId: string, safeErrorSummary: string): Promise<void> {
    this.transitions.push({ runId, status: "needs_admin_action", safeErrorSummary });
  }

  async markFailed(runId: string, safeErrorSummary: string): Promise<void> {
    this.transitions.push({ runId, status: "failed", safeErrorSummary });
  }
}

class FakeTransactionRepository {
  readonly received: Awaited<ReturnType<typeof import("../../modules/transactions").normalizeBankMovement>>[] = [];

  constructor(private readonly result: { inserted: number; skipped: number }) {}

  async upsertMany(records: typeof this.received): Promise<{ inserted: number; skipped: number }> {
    this.received.push(...records);
    return this.result;
  }
}

class FakeQueue {
  readonly addCalls: Array<{ name: string; data: IngestionJobData; options: unknown }> = [];

  async add(name: string, data: IngestionJobData, options: unknown): Promise<void> {
    this.addCalls.push({ name, data, options });
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
}
