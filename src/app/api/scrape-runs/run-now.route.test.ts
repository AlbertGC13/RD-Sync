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

  it("does NOT honor previewRole=admin as an admin bypass", async () => {
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

      // The previewRole backdoor is removed — without a real principal, the
      // request is rejected (401). Even with the dev preview flag, query
      // params must not substitute for a signed cookie / trusted headers.
      expect(response.status).toBe(401);
      expect(await scrapeRuns.list({})).toEqual([]);
      expect(queue.addCalls).toEqual([]);
    } finally {
      if (previousValue === undefined) {
        delete process.env.RD_SYNC_DEV_PREVIEW;
      } else {
        process.env.RD_SYNC_DEV_PREVIEW = previousValue;
      }
    }
  });

  it("allows non-admin users (viewer) to schedule a run from the transactions refresh", async () => {
    const scrapeRuns = new InMemoryScrapeRunRepository();
    const queue = new FakeQueue();
    const handler = createPostScrapeRunNowHandler({
      scrapeRuns,
      queue,
      now: () => new Date("2026-06-09T12:15:00.000Z"),
      createRunId: () => "viewer-manual-run",
    });

    const response = await handler(
      new Request("http://localhost/api/scrape-runs/run-now", {
        method: "POST",
        headers: {
          "x-rd-sync-user-id": "viewer-1",
          "x-rd-sync-role": "viewer",
        },
      }),
    );

    expect(response.status).toBe(202);
    expect(await scrapeRuns.list({})).toMatchObject([
      { id: "viewer-manual-run", bankId: "popular", status: "queued" },
    ]);
    expect(queue.addCalls).toHaveLength(1);
  });

  it("allows reviewers to schedule a run from the transactions refresh", async () => {
    const scrapeRuns = new InMemoryScrapeRunRepository();
    const queue = new FakeQueue();
    const handler = createPostScrapeRunNowHandler({
      scrapeRuns,
      queue,
      now: () => new Date("2026-06-09T12:15:00.000Z"),
      createRunId: () => "reviewer-manual-run",
    });

    const response = await handler(
      new Request("http://localhost/api/scrape-runs/run-now", {
        method: "POST",
        headers: {
          "x-rd-sync-user-id": "reviewer-1",
          "x-rd-sync-role": "reviewer",
        },
      }),
    );

    expect(response.status).toBe(202);
    expect(queue.addCalls).toHaveLength(1);
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
    expect(await response.json()).toEqual({ error: "Unable to schedule run" });
    expect(await scrapeRuns.list({})).toEqual([]);
    expect(queue.addCalls).toEqual([]);
  });

  it("schedules a BHD ingestion run when bankId='bhd' is requested", async () => {
    const scrapeRuns = new InMemoryScrapeRunRepository();
    const queue = new FakeQueue();
    const handler = createPostScrapeRunNowHandler({
      scrapeRuns,
      queue,
      now: () => new Date("2026-06-09T12:15:00.000Z"),
      createRunId: () => "bhd-manual-run",
    });

    const response = await handler(
      new Request("http://localhost/api/scrape-runs/run-now", {
        method: "POST",
        headers: {
          "x-rd-sync-user-id": "admin-1",
          "x-rd-sync-role": "admin",
        },
        body: JSON.stringify({ bankId: "bhd" }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(202);
    expect(body).toEqual({
      run: {
        runId: "bhd-manual-run",
        bankId: "bhd",
        accountFingerprint: "popular-0000000000",
        status: "queued",
      },
    });
    expect(queue.addCalls[0]?.data.bankId).toBe("bhd");
  });

  it("schedules a Banreservas Personas run when bankId='banreservas_personas' is requested", async () => {
    const scrapeRuns = new InMemoryScrapeRunRepository();
    const queue = new FakeQueue();
    const handler = createPostScrapeRunNowHandler({
      scrapeRuns,
      queue,
      now: () => new Date("2026-06-09T12:15:00.000Z"),
      createRunId: () => "br-personas-run",
    });

    const response = await handler(
      new Request("http://localhost/api/scrape-runs/run-now", {
        method: "POST",
        headers: {
          "x-rd-sync-user-id": "admin-1",
          "x-rd-sync-role": "admin",
        },
        body: JSON.stringify({ bankId: "banreservas_personas" }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(202);
    expect(body.run.bankId).toBe("banreservas_personas");
    expect(queue.addCalls[0]?.data.bankId).toBe("banreservas_personas");
  });

  it("schedules a Banreservas Empresas run when bankId='banreservas_empresas' is requested", async () => {
    const scrapeRuns = new InMemoryScrapeRunRepository();
    const queue = new FakeQueue();
    const handler = createPostScrapeRunNowHandler({
      scrapeRuns,
      queue,
      now: () => new Date("2026-06-09T12:15:00.000Z"),
      createRunId: () => "br-empresas-run",
    });

    const response = await handler(
      new Request("http://localhost/api/scrape-runs/run-now", {
        method: "POST",
        headers: {
          "x-rd-sync-user-id": "admin-1",
          "x-rd-sync-role": "admin",
        },
        body: JSON.stringify({ bankId: "banreservas_empresas" }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(202);
    expect(body.run.bankId).toBe("banreservas_empresas");
    expect(queue.addCalls[0]?.data.bankId).toBe("banreservas_empresas");
  });

  it("returns 400 with a safe message when an unknown bankId is requested", async () => {
    const scrapeRuns = new InMemoryScrapeRunRepository();
    const queue = new FakeQueue();
    const handler = createPostScrapeRunNowHandler({ scrapeRuns, queue });

    const response = await handler(
      new Request("http://localhost/api/scrape-runs/run-now", {
        method: "POST",
        headers: {
          "x-rd-sync-user-id": "admin-1",
          "x-rd-sync-role": "admin",
        },
        body: JSON.stringify({ bankId: "unknown-bank" }),
      }),
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("Bank not currently supported for manual runs");
    // Nothing should have been queued for an unsupported bank.
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
