import { describe, expect, it } from "vitest";

import {
  createPreviewScrapeRunRecords,
  InMemoryScheduledIngestionQueue,
  listScrapeRunsForPage,
} from "./defaults";

describe("createPreviewScrapeRunRecords", () => {
  it("creates safe admin preview runs without credentials, cookies, or token values", () => {
    const runs = createPreviewScrapeRunRecords(new Date("2026-06-08T16:00:00.000Z"));

    expect(runs.map((run) => run.status)).toEqual([
      "needs_admin_action",
      "succeeded",
      "failed",
      "succeeded",
    ]);
    expect(JSON.stringify(runs)).not.toContain("password=");
    expect(JSON.stringify(runs)).not.toContain("token=");
    expect(JSON.stringify(runs)).not.toContain("cookie=");
  });
});

describe("listScrapeRunsForPage", () => {
  it("returns no page runs unless local preview seeding is explicitly enabled", async () => {
    const previousValue = process.env.RD_SYNC_DEV_PREVIEW;

    try {
      delete process.env.RD_SYNC_DEV_PREVIEW;

      expect(await listScrapeRunsForPage({ bankId: "popular" })).toEqual([]);
    } finally {
      if (previousValue === undefined) {
        delete process.env.RD_SYNC_DEV_PREVIEW;
      } else {
        process.env.RD_SYNC_DEV_PREVIEW = previousValue;
      }
    }
  });
});

describe("InMemoryScheduledIngestionQueue", () => {
  it("records scheduled ingestion jobs for local server mode", async () => {
    const queue = new InMemoryScheduledIngestionQueue();

    await queue.add("bank-transaction-ingestion", {
      runId: "run-1",
      bankId: "popular",
      accountFingerprint: "popular-817985690",
    }, {
      jobId: "run-1",
      attempts: 3,
    });

    expect(queue.jobs).toEqual([
      {
        name: "bank-transaction-ingestion",
        data: {
          runId: "run-1",
          bankId: "popular",
          accountFingerprint: "popular-817985690",
        },
        options: {
          jobId: "run-1",
          attempts: 3,
        },
      },
    ]);
  });
});
