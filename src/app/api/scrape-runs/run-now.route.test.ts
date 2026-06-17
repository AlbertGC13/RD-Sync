import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { InMemoryScrapeRunRepository } from "../../../modules/scrape-runs";
import type { IngestionJobData, QueueLike } from "../../../worker/queues";
import { createPostScrapeRunNowHandler } from "./run-now/route";

describe("POST /api/scrape-runs/run-now", () => {
  beforeEach(() => {
    process.env.RD_SYNC_TRUST_PROXY_HEADERS = "enabled";
  });

  afterEach(() => {
    delete process.env.RD_SYNC_TRUST_PROXY_HEADERS;
  });

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
        accountFingerprint: "popular-0000000000",
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
          accountFingerprint: "popular-0000000000",
        },
      },
    ]);
  });

  it("supports local admin preview when explicitly enabled", async () => {
    const previousValue = process.env.RD_SYNC_DEV_PREVIEW;
    const scrapeRuns = new InMemoryScrapeRunRepository();
    const queue = new FakeQueue();
    const handler = createPostScrapeRunNowHandler({
      scrapeRuns,
      queue,
      createRunId: () => "popular-preview-run",
    });

    try {
      process.env.RD_SYNC_DEV_PREVIEW = "enabled";

      const response = await handler(
        new Request("http://localhost/api/scrape-runs/run-now?previewRole=admin", {
          method: "POST",
        }),
      );

      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({
        run: expect.objectContaining({ runId: "popular-preview-run", status: "queued" }),
      });
      expect(queue.addCalls).toHaveLength(1);
    } finally {
      if (previousValue === undefined) {
        delete process.env.RD_SYNC_DEV_PREVIEW;
      } else {
        process.env.RD_SYNC_DEV_PREVIEW = previousValue;
      }
    }
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

  it("returns 401 when no identity is provided", async () => {
    const scrapeRuns = new InMemoryScrapeRunRepository();
    const queue = new FakeQueue();
    const handler = createPostScrapeRunNowHandler({ scrapeRuns, queue });

    const response = await handler(
      new Request("http://localhost/api/scrape-runs/run-now", {
        method: "POST",
      }),
    );

    expect(response.status).toBe(401);
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
