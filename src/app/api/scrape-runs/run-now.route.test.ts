import { describe, expect, it } from "vitest";

import { InMemoryScrapeRunRepository } from "../../../modules/scrape-runs";
import type { IngestionJobData, QueueLike } from "../../../worker/queues";
import { createPostScrapeRunNowHandler } from "./run-now/route";

describe("POST /api/scrape-runs/run-now", () => {
  it("schedules a Popular ingestion run for admins", async () => {
    const scrapeRuns = new InMemoryScrapeRunRepository();
    const queue = new FakeQueue();
    const handler = createPostScrapeRunNowHandler({
      scrapeRuns,
      queue,
      now: () => new Date("2026-06-09T12:15:00.000Z"),
      createRunId: () => "popular-manual-run",
    });

    const response = await handler(
      new Request("http://localhost/api/scrape-runs/run-now", {
        method: "POST",
        headers: {
          "x-rd-sync-user-id": "admin-1",
          "x-rd-sync-role": "admin",
        },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(202);
    expect(body).toEqual({
      run: {
        runId: "popular-manual-run",
        bankId: "popular",
        accountFingerprint: "popular-817985690",
        status: "queued",
      },
    });
    expect(await scrapeRuns.list({})).toMatchObject([
      { id: "popular-manual-run", bankId: "popular", status: "queued" },
    ]);
    expect(queue.addCalls).toEqual([
      {
        name: "bank-transaction-ingestion",
        data: {
          runId: "popular-manual-run",
          bankId: "popular",
          accountFingerprint: "popular-817985690",
        },
      },
    ]);
  });

  it("denies non-admin users without scheduling a job", async () => {
    const scrapeRuns = new InMemoryScrapeRunRepository();
    const queue = new FakeQueue();
    const handler = createPostScrapeRunNowHandler({ scrapeRuns, queue });

    const response = await handler(
      new Request("http://localhost/api/scrape-runs/run-now", {
        method: "POST",
        headers: {
          "x-rd-sync-user-id": "viewer-1",
          "x-rd-sync-role": "viewer",
        },
      }),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Admin role required" });
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
