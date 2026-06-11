import { describe, expect, it } from "vitest";

import { InMemoryScrapeRunRepository } from "../../../modules/scrape-runs";
import { createRunId, scheduleAdminIngestionRunNow } from "./run-now";
import type { IngestionJobData, QueueLike } from "../../../worker/queues";

describe("createRunId", () => {
  it("uses millisecond precision plus a suffix to avoid rapid-click collisions", () => {
    const now = new Date("2026-06-09T12:00:00.123Z");

    const first = createRunId({ bankId: "popular", now });
    const second = createRunId({ bankId: "popular", now });
    const third = createRunId({
      bankId: "popular",
      now: new Date("2026-06-09T12:00:00.124Z"),
    });

    expect(first).toMatch(/^popular-20260609120000123-[a-z0-9]{4}$/);
    expect(new Set([first, second, third]).size).toBe(3);
  });
});

describe("scheduleAdminIngestionRunNow", () => {
  it("creates a queued Popular scrape run and schedules ingestion for admins", async () => {
    const scrapeRuns = new InMemoryScrapeRunRepository();
    const queue = new FakeQueue();

    const result = await scheduleAdminIngestionRunNow(
      { principal: { id: "admin-1", role: "admin" } },
      {
        scrapeRuns,
        queue,
        now: () => new Date("2026-06-09T12:00:00.000Z"),
        createRunId: () => "run-popular-now",
      },
    );

    expect(result).toEqual({
      runId: "run-popular-now",
      bankId: "popular",
      accountFingerprint: "popular-817985690",
      status: "queued",
    });
    expect(await scrapeRuns.list({})).toMatchObject([
      { id: "run-popular-now", bankId: "popular", status: "queued" },
    ]);
    expect(queue.addCalls).toEqual([
      {
        name: "bank-transaction-ingestion",
        data: {
          runId: "run-popular-now",
          bankId: "popular",
          accountFingerprint: "popular-817985690",
        },
        options: {
          jobId: "run-popular-now",
          attempts: 3,
          backoff: { type: "exponential", delay: 30_000 },
          removeOnComplete: 100,
          removeOnFail: 250,
        },
      },
    ]);
  });

  it("schedules two admin run-now requests created in the same second", async () => {
    const scrapeRuns = new InMemoryScrapeRunRepository();
    const queue = new FakeQueue();
    const now = () => new Date("2026-06-09T12:00:00.123Z");

    const first = await scheduleAdminIngestionRunNow(
      { principal: { id: "admin-1", role: "admin" } },
      { scrapeRuns, queue, now },
    );
    const second = await scheduleAdminIngestionRunNow(
      { principal: { id: "admin-1", role: "admin" } },
      { scrapeRuns, queue, now },
    );

    expect(first.runId).not.toBe(second.runId);
    expect(await scrapeRuns.list({})).toHaveLength(2);
    expect(queue.addCalls).toHaveLength(2);
  });

  it("denies viewers without creating runs or scheduling jobs", async () => {
    const scrapeRuns = new InMemoryScrapeRunRepository();
    const queue = new FakeQueue();

    await expect(
      scheduleAdminIngestionRunNow(
        { principal: { id: "viewer-1", role: "viewer" } },
        { scrapeRuns, queue },
      ),
    ).rejects.toThrow("Admin role required");

    expect(await scrapeRuns.list({})).toEqual([]);
    expect(queue.addCalls).toEqual([]);
  });
});

class FakeQueue implements QueueLike {
  readonly addCalls: Array<{
    name: string;
    data: IngestionJobData;
    options: Parameters<QueueLike["add"]>[2];
  }> = [];

  async add(
    name: string,
    data: IngestionJobData,
    options: Parameters<QueueLike["add"]>[2],
  ): Promise<void> {
    this.addCalls.push({ name, data, options });
  }
}
