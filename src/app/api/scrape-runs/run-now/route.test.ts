import { describe, expect, it } from "vitest";

import { InMemoryScrapeRunRepository } from "../../../../modules/scrape-runs";
import { createPostScrapeRunNowHandler, resolveApiPreviewPrincipal } from "./route";
import type { IngestionJobData, QueueLike } from "../../../../worker/queues";
import { createInMemoryIngestionConsumer } from "../../../../worker/ingestion-consumer";
import { createIngestionProcessor } from "../../../../worker/queues";
import { InMemoryScheduledIngestionQueue } from "../defaults";

describe("resolveApiPreviewPrincipal", () => {
  it("disables preview admin access in production", () => {
    withEnv({ NODE_ENV: "production", RD_SYNC_DEV_PREVIEW: "enabled" }, () => {
      expect(resolveApiPreviewPrincipal(new URLSearchParams("previewRole=admin"))).toBeNull();
    });
  });
});

describe("POST /api/scrape-runs/run-now", () => {
  it("does not allow previewRole admin to schedule runs in production", async () => {
    const scrapeRuns = new InMemoryScrapeRunRepository();
    const queue = new FakeQueue();
    const handler = createPostScrapeRunNowHandler({ scrapeRuns, queue });

    const response = await withEnv(
      { NODE_ENV: "production", RD_SYNC_DEV_PREVIEW: "enabled" },
      () => handler(new Request("https://rd-sync.test/api/scrape-runs/run-now?previewRole=admin")),
    );

    expect(response.status).toBe(401);
    expect(await scrapeRuns.list({})).toEqual([]);
    expect(queue.addCalls).toEqual([]);
  });
});

describe("POST /api/scrape-runs/run-now — consumer kick", () => {
  it("returns 202 and the run is no longer queued after the consumer settles", async () => {
    const scrapeRuns = new InMemoryScrapeRunRepository();
    const queue = new InMemoryScheduledIngestionQueue();

    // Processor that transitions to succeeded (fixture movements)
    const processor = createIngestionProcessor({
      scrapeRuns,
      transactions: { upsertMany: async () => ({ inserted: 1, skipped: 0 }) },
      scraper: {
        collect: async () => ({
          status: "collected" as const,
          movements: [
            {
              bankId: "popular",
              accountFingerprint: "popular-test",
              postedAt: "2026-06-07T00:00:00-04:00",
              amount: "100.00",
              currency: "DOP",
              direction: "credit" as const,
              reference: "REF-route",
              concept: null,
              originator: null,
            },
          ],
        }),
      },
    });

    const consumer = createInMemoryIngestionConsumer({ queue, processor });

    const handler = createPostScrapeRunNowHandler({
      scrapeRuns,
      queue,
      consumer,
    });

    const response = await withEnv(
      { RD_SYNC_DEV_PREVIEW: "enabled" },
      () => handler(new Request("https://rd-sync.test/api/scrape-runs/run-now?previewRole=admin")),
    );

    expect(response.status).toBe(202);
    const body = (await response.json()) as { run: { runId: string } };
    const { runId } = body.run;

    // Wait for the fire-and-forget drain to settle
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const runs = await scrapeRuns.list({});
    const run = runs.find((r) => r.id === runId);
    expect(run).toBeDefined();
    expect(run?.status).not.toBe("queued");
    expect(queue.jobs).toHaveLength(0);
  });
});

function withEnv<T>(values: Record<string, string | undefined>, callback: () => T): T {
  const previous = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  ) as Record<string, string | undefined>;

  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return callback();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

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
