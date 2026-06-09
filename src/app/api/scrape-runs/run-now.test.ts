import { describe, expect, it } from "vitest";

import { InMemoryScrapeRunRepository } from "../../../modules/scrape-runs";
import { scheduleAdminIngestionRunNow } from "./run-now";
import type { IngestionJobData, QueueLike } from "../../../worker/queues";

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
      },
    ]);
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
  readonly addCalls: Array<{ name: string; data: IngestionJobData }> = [];

  async add(name: string, data: IngestionJobData): Promise<void> {
    this.addCalls.push({ name, data });
  }
}
