import { describe, expect, it } from "vitest";

import { InMemoryScrapeRunRepository } from "../../../../modules/scrape-runs";
import { createPostScrapeRunNowHandler, resolveApiPreviewPrincipal } from "./route";
import type { IngestionJobData, QueueLike } from "../../../../worker/queues";

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
