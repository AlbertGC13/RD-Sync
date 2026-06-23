import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InMemoryScrapeRunRepository } from "../../../../modules/scrape-runs";
import { createPostScrapeRunNowHandler, SAFE_CONFLICT_MESSAGE } from "./route";
import type { IngestionJobData, QueueLike } from "../../../../worker/queues";
import { createInMemoryIngestionConsumer } from "../../../../worker/ingestion-consumer";
import { createIngestionProcessor } from "../../../../worker/queues";
import { InMemoryScheduledIngestionQueue } from "../defaults";
import { redactDiagnosticText } from "../../../../worker/scraper";

describe("POST /api/scrape-runs/run-now — previewRole bypass is removed", () => {
  beforeEach(() => {
    process.env.RD_SYNC_TRUST_PROXY_HEADERS = "enabled";
  });

  afterEach(() => {
    delete process.env.RD_SYNC_TRUST_PROXY_HEADERS;
    delete process.env.RD_SYNC_DEV_PREVIEW;
  });

  it("returns 401 with a previewRole=admin query param and no headers", async () => {
    const scrapeRuns = new InMemoryScrapeRunRepository();
    const queue = new FakeQueue();
    const handler = createPostScrapeRunNowHandler({ scrapeRuns, queue });

    const response = await handler(
      new Request("https://rd-sync.test/api/scrape-runs/run-now?previewRole=admin", {
        method: "POST",
      }),
    );

    expect(response.status).toBe(401);
    expect(await scrapeRuns.list({})).toEqual([]);
    expect(queue.addCalls).toEqual([]);
  });

  it("returns 401 with previewRole=admin even when RD_SYNC_DEV_PREVIEW=enabled", async () => {
    const previousPreview = process.env.RD_SYNC_DEV_PREVIEW;
    const scrapeRuns = new InMemoryScrapeRunRepository();
    const queue = new FakeQueue();
    const handler = createPostScrapeRunNowHandler({ scrapeRuns, queue });

    try {
      process.env.RD_SYNC_DEV_PREVIEW = "enabled";

      const response = await handler(
        new Request("https://rd-sync.test/api/scrape-runs/run-now?previewRole=admin", {
          method: "POST",
        }),
      );

      expect(response.status).toBe(401);
      expect(await scrapeRuns.list({})).toEqual([]);
      expect(queue.addCalls).toEqual([]);
    } finally {
      if (previousPreview === undefined) {
        delete process.env.RD_SYNC_DEV_PREVIEW;
      } else {
        process.env.RD_SYNC_DEV_PREVIEW = previousPreview;
      }
    }
  });
});

describe("POST /api/scrape-runs/run-now — user-safe error message", () => {
  beforeEach(() => {
    process.env.RD_SYNC_TRUST_PROXY_HEADERS = "enabled";
  });

  afterEach(() => {
    delete process.env.RD_SYNC_TRUST_PROXY_HEADERS;
  });

  it("returns a generic error message on 401 (no leaked stack/details)", async () => {
    const scrapeRuns = new InMemoryScrapeRunRepository();
    const queue = new FakeQueue();
    const handler = createPostScrapeRunNowHandler({ scrapeRuns, queue });

    const response = await handler(
      new Request("https://rd-sync.test/api/scrape-runs/run-now", {
        method: "POST",
      }),
    );

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("Unable to schedule run");
    // Defensive: must never echo the raw auth error or stack.
    expect(body.error).not.toContain("Authentication");
    expect(body.error).not.toContain("stack");
  });
});

describe("POST /api/scrape-runs/run-now — consumer kick", () => {
  beforeEach(() => {
    process.env.RD_SYNC_TRUST_PROXY_HEADERS = "enabled";
  });

  afterEach(() => {
    delete process.env.RD_SYNC_TRUST_PROXY_HEADERS;
  });

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

    const response = await handler(
      new Request("https://rd-sync.test/api/scrape-runs/run-now", {
        method: "POST",
        headers: {
          "x-rd-sync-user-id": "admin-1",
          "x-rd-sync-role": "admin",
        },
        body: JSON.stringify({ bankId: "popular" }),
      }),
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

describe("POST /api/scrape-runs/run-now — resilience: auth vs infra vs validation", () => {
  beforeEach(() => {
    process.env.RD_SYNC_TRUST_PROXY_HEADERS = "enabled";
  });

  afterEach(() => {
    delete process.env.RD_SYNC_TRUST_PROXY_HEADERS;
  });

  it("returns 400 with a generic message when an unsupported bank is requested (NOT 401/403)", async () => {
    const scrapeRuns = new InMemoryScrapeRunRepository();
    const queue = new FakeQueue();
    const handler = createPostScrapeRunNowHandler({ scrapeRuns, queue });

    const response = await handler(
      new Request("https://rd-sync.test/api/scrape-runs/run-now", {
        method: "POST",
        headers: {
          "x-rd-sync-user-id": "admin-1",
          "x-rd-sync-role": "admin",
        },
        body: JSON.stringify({ bankId: "banreservas" }),
      }),
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("Bank not currently supported for manual runs");
    // Nothing should have been queued.
    expect(await scrapeRuns.list({})).toEqual([]);
    expect(queue.addCalls).toEqual([]);
  });

  it("returns 503 with a generic message when the queue throws (infrastructure failure)", async () => {
    const scrapeRuns = new InMemoryScrapeRunRepository();
    const queue = new FailingQueue(new Error("Redis ECONNREFUSED 127.0.0.1:6379"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const handler = createPostScrapeRunNowHandler({ scrapeRuns, queue });
      const response = await handler(
        new Request("https://rd-sync.test/api/scrape-runs/run-now", {
          method: "POST",
          headers: {
            "x-rd-sync-user-id": "admin-1",
            "x-rd-sync-role": "admin",
          },
          body: JSON.stringify({ bankId: "popular" }),
        }),
      );

      // Infrastructure failure → 5xx, never 401/403.
      expect(response.status).toBe(503);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("Unable to schedule run");
      // User-safe response: raw error details must NEVER leak to the browser.
      expect(body.error).not.toContain("Redis");
      expect(body.error).not.toContain("ECONNREFUSED");
      expect(body.error).not.toContain("stack");
      // Server-side diagnostic log must include enough context to debug.
      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const logArg = consoleSpy.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(logArg).toMatchObject({ actorId: "admin-1", actorRole: "admin", bankId: "popular" });
      const nestedError = logArg.error as { message?: string };
      expect(nestedError?.message).toContain("Redis ECONNREFUSED");
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("returns 503 and logs when the repository throws (DB failure)", async () => {
    const queue = new FakeQueue();
    const scrapeRuns = new FailingScrapeRunRepository(new Error("Prisma pool timeout"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const handler = createPostScrapeRunNowHandler({ scrapeRuns, queue });
      const response = await handler(
        new Request("https://rd-sync.test/api/scrape-runs/run-now", {
          method: "POST",
          headers: {
            "x-rd-sync-user-id": "admin-1",
            "x-rd-sync-role": "admin",
          },
        }),
      );

      expect(response.status).toBe(503);
      const body = (await response.json()) as { error: string };
      expect(body.error).not.toContain("Prisma");
      expect(body.error).not.toContain("pool");
      expect(consoleSpy).toHaveBeenCalledTimes(1);
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("marks the persisted scrape run as failed (not queued) when the queue throws", async () => {
    // Direct unit-level use of the in-memory repo + a queue that fails.
    // This is the surgical regression coverage for the BLOCKER: a failed
    // queue.schedule must NOT leave a run with status=queued in the repo.
    const scrapeRuns = new InMemoryScrapeRunRepository();
    const queue = new FailingQueue(new Error("Redis ECONNREFUSED token=abc123"));
    const handler = createPostScrapeRunNowHandler({ scrapeRuns, queue });

    const response = await handler(
      new Request("https://rd-sync.test/api/scrape-runs/run-now", {
        method: "POST",
        headers: {
          "x-rd-sync-user-id": "admin-1",
          "x-rd-sync-role": "admin",
        },
        body: JSON.stringify({ bankId: "popular" }),
      }),
    );

    expect(response.status).toBe(503);

    const runs = await scrapeRuns.list({});
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("failed");
    expect(runs[0]?.safeErrorSummary).not.toContain("abc123");
    expect(runs[0]?.safeErrorSummary).toContain("[REDACTED]");
  });
});

describe("POST /api/scrape-runs/run-now — active-run lock (409)", () => {
  beforeEach(() => {
    process.env.RD_SYNC_TRUST_PROXY_HEADERS = "enabled";
  });

  afterEach(() => {
    delete process.env.RD_SYNC_TRUST_PROXY_HEADERS;
  });

  it("returns 409 with a safe conflict message when an active run already exists for the bank", async () => {
    const repo = new InMemoryScrapeRunRepository();
    // Seed an existing queued run so the lock observes it.
    await repo.createQueued({ id: "existing-active", bankId: "popular" });
    const queue = new FakeQueue();
    const handler = createPostScrapeRunNowHandler({
      scrapeRuns: {
        createQueued: (input) => repo.createQueued(input),
        markFailed: (runId, summary, endedAt) => repo.markFailed(runId, summary, endedAt),
        hasActiveRunForBank: async (bankId: string) => {
          const active = await repo.list({ bankId });
          return active.some((run) => run.status === "queued" || run.status === "running");
        },
      },
      queue,
    });

    const response = await handler(
      new Request("https://rd-sync.test/api/scrape-runs/run-now", {
        method: "POST",
        headers: {
          "x-rd-sync-user-id": "admin-1",
          "x-rd-sync-role": "admin",
        },
        body: JSON.stringify({ bankId: "popular" }),
      }),
    );

    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe(SAFE_CONFLICT_MESSAGE);
    // No new run was created and no job was scheduled.
    const runs = await repo.list({});
    expect(runs).toHaveLength(1);
    expect(runs[0]?.id).toBe("existing-active");
    expect(queue.addCalls).toEqual([]);
  });
});

describe("POST /api/scrape-runs/run-now — in-memory drain orphan recovery", () => {
  beforeEach(() => {
    process.env.RD_SYNC_TRUST_PROXY_HEADERS = "enabled";
  });

  afterEach(() => {
    delete process.env.RD_SYNC_TRUST_PROXY_HEADERS;
  });

  it("marks the scrape run failed when the dequeued processor throws before its own catch", async () => {
    // Regression for the BLOCKER: the consumer removes the job from the
    // in-memory queue before processing. If the processor throws at
    // `markRunning` (before its try/catch), the run would otherwise stay
    // `queued` with no pending job — an orphan. The consumer's onJobError
    // recovery must mark it `failed` with a redacted summary.
    const scrapeRuns = new InMemoryScrapeRunRepository();
    const queue = new InMemoryScheduledIngestionQueue();

    // Processor that throws at markRunning (simulating a repo failure before
    // the processor's try/catch can recover).
    const throwingProcessor = async () => {
      throw new Error("markRunning failed: Prisma timeout token=secret");
    };

    const consumer = createInMemoryIngestionConsumer({
      queue,
      processor: throwingProcessor,
      onJobError: async (job, error) => {
        const safeSummary = redactDiagnosticText(error.message);
        await scrapeRuns.markFailed(job.data.runId, safeSummary, new Date());
      },
    });

    const handler = createPostScrapeRunNowHandler({
      scrapeRuns,
      queue,
      consumer,
      now: () => new Date("2026-06-09T12:00:00.000Z"),
      createRunId: () => "orphan-run",
    });

    const response = await handler(
      new Request("https://rd-sync.test/api/scrape-runs/run-now", {
        method: "POST",
        headers: {
          "x-rd-sync-user-id": "admin-1",
          "x-rd-sync-role": "admin",
        },
        body: JSON.stringify({ bankId: "popular" }),
      }),
    );

    expect(response.status).toBe(202);

    // Wait for the fire-and-forget drain to settle.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const runs = await scrapeRuns.list({});
    const run = runs.find((r) => r.id === "orphan-run");
    expect(run).toBeDefined();
    // The orphaned run must NOT remain queued — recovery marked it failed.
    expect(run?.status).toBe("failed");
    // The safe summary must have credentials redacted (no raw token leaked).
    expect(run?.safeErrorSummary).not.toContain("secret");
    expect(run?.safeErrorSummary).toContain("[REDACTED]");
    // The job was consumed (removed) from the in-memory queue.
    expect(queue.jobs).toHaveLength(0);
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

class FailingQueue implements QueueLike {
  constructor(private readonly error: Error) {}

  readonly addCalls: Array<{
    name: string;
    data: IngestionJobData;
    options: Parameters<QueueLike["add"]>[2];
  }> = [];

  async add(): Promise<void> {
    throw this.error;
  }
}

class FailingScrapeRunRepository {
  constructor(private readonly error: Error) {}

  async createQueued(): Promise<{ status: "queued" }> {
    throw this.error;
  }

  // markFailed is part of the run-now scrape-run contract. This fake simulates
  // a repository failure during createQueued, so markFailed is unreachable —
  // but the type signature requires it, so we throw a descriptive error if a
  // future test ever drives this path.
  async markFailed(): Promise<void> {
    throw new Error("FailingScrapeRunRepository: markFailed should not be reachable");
  }
}
