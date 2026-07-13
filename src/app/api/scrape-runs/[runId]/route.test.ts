import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InMemoryScrapeRunRepository } from "../../../../modules/scrape-runs";
import {
  createGetScrapeRunStatusHandler,
  toSafeScrapeRunStatus,
} from "./route";

describe("GET /api/scrape-runs/[runId] — single-run status", () => {
  beforeEach(() => {
    process.env.RD_SYNC_TRUST_PROXY_HEADERS = "enabled";
  });

  afterEach(() => {
    delete process.env.RD_SYNC_TRUST_PROXY_HEADERS;
  });

  async function seedSucceededRun(repo: InMemoryScrapeRunRepository, runId = "popular-run-1") {
    await repo.createQueued({ id: runId, bankId: "popular" });
    await repo.markRunning(runId, new Date("2026-06-09T12:00:30.000Z"));
    await repo.markSucceeded(
      runId,
      { insertedCount: 7, skippedCount: 2 },
      new Date("2026-06-09T12:01:15.000Z"),
    );
  }

  it("lets an authenticated viewer read a run's status", async () => {
    const repo = new InMemoryScrapeRunRepository();
    await seedSucceededRun(repo);
    const handler = createGetScrapeRunStatusHandler({ scrapeRuns: repo });

    const response = await handler(
      new Request("https://rd-sync.test/api/scrape-runs/popular-run-1", {
        method: "GET",
        headers: {
          "x-rd-sync-user-id": "viewer-1",
          "x-rd-sync-role": "viewer",
        },
      }),
      { params: Promise.resolve({ runId: "popular-run-1" }) },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { run: Record<string, unknown> };
    expect(body.run).toEqual({
      id: "popular-run-1",
      bankId: "popular",
      status: "succeeded",
      insertedCount: 7,
      skippedCount: 2,
    });
  });

  it("exposes throttled as a terminal status without exposing its safe summary", async () => {
    const repo = new InMemoryScrapeRunRepository();
    await repo.createQueued({ id: "run-throttled", bankId: "popular" });
    await repo.markThrottled(
      "run-throttled",
      "Bank browser capacity is temporarily unavailable token=secret",
      new Date("2026-06-09T12:01:15.000Z"),
    );
    const handler = createGetScrapeRunStatusHandler({ scrapeRuns: repo });

    const response = await handler(
      new Request("https://rd-sync.test/api/scrape-runs/run-throttled", {
        method: "GET",
        headers: { "x-rd-sync-user-id": "viewer-1", "x-rd-sync-role": "viewer" },
      }),
      { params: Promise.resolve({ runId: "run-throttled" }) },
    );

    expect(await response.json()).toEqual({
      run: {
        id: "run-throttled",
        bankId: "popular",
        status: "throttled",
        insertedCount: 0,
        skippedCount: 0,
      },
    });
  });

  it("also admits reviewer and admin roles", async () => {
    const repo = new InMemoryScrapeRunRepository();
    await seedSucceededRun(repo, "run-x");
    const handler = createGetScrapeRunStatusHandler({ scrapeRuns: repo });

    for (const role of ["reviewer", "admin"] as const) {
      const response = await handler(
        new Request(`https://rd-sync.test/api/scrape-runs/run-x`, {
          method: "GET",
          headers: { "x-rd-sync-user-id": `${role}-1`, "x-rd-sync-role": role },
        }),
        { params: Promise.resolve({ runId: "run-x" }) },
      );

      expect(response.status).toBe(200);
    }
  });

  it("returns 401 when no identity is provided", async () => {
    const repo = new InMemoryScrapeRunRepository();
    const handler = createGetScrapeRunStatusHandler({ scrapeRuns: repo });

    const response = await handler(
      new Request("https://rd-sync.test/api/scrape-runs/any", { method: "GET" }),
      { params: Promise.resolve({ runId: "any" }) },
    );

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("Authentication required");
  });

  it("returns 404 with a safe message for a missing run", async () => {
    const repo = new InMemoryScrapeRunRepository();
    const handler = createGetScrapeRunStatusHandler({ scrapeRuns: repo });

    const response = await handler(
      new Request("https://rd-sync.test/api/scrape-runs/ghost", {
        method: "GET",
        headers: {
          "x-rd-sync-user-id": "viewer-1",
          "x-rd-sync-role": "viewer",
        },
      }),
      { params: Promise.resolve({ runId: "ghost" }) },
    );

    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("Scrape run not found");
  });

  it("never exposes unsafe fields (timestamps, error summary, fingerprints) in the response", async () => {
    const repo = new InMemoryScrapeRunRepository();
    await repo.createQueued({ id: "run-leak", bankId: "popular" });
    await repo.markFailed("run-leak", "Browser crashed: cookie=secret-token-123", new Date());

    const handler = createGetScrapeRunStatusHandler({ scrapeRuns: repo });

    const response = await handler(
      new Request("https://rd-sync.test/api/scrape-runs/run-leak", {
        method: "GET",
        headers: {
          "x-rd-sync-user-id": "viewer-1",
          "x-rd-sync-role": "viewer",
        },
      }),
      { params: Promise.resolve({ runId: "run-leak" }) },
    );

    expect(response.status).toBe(200);
    const text = await response.text();

    // The safe shape contains only id/bankId/status/insertedCount/skippedCount.
    expect(text).not.toContain("safeErrorSummary");
    expect(text).not.toContain("createdAt");
    expect(text).not.toContain("updatedAt");
    expect(text).not.toContain("startedAt");
    expect(text).not.toContain("endedAt");
    expect(text).not.toContain("accountFingerprint");
    // The redacted error summary (with the secret token) must never reach the
    // browser through this endpoint.
    expect(text).not.toContain("secret-token");
    expect(text).not.toContain("cookie");
  });

  it("returns 503 with a generic message and logs server-side when the repository throws", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const handler = createGetScrapeRunStatusHandler({
        scrapeRuns: {
          findById: () => {
            throw new Error("Prisma connection refused 127.0.0.1:5432");
          },
        },
      });

      const response = await handler(
        new Request("https://rd-sync.test/api/scrape-runs/any", {
          method: "GET",
          headers: {
            "x-rd-sync-user-id": "viewer-1",
            "x-rd-sync-role": "viewer",
          },
        }),
        { params: Promise.resolve({ runId: "any" }) },
      );

      expect(response.status).toBe(503);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("Unable to read scrape run status");
      // User-safe response: raw error details must NEVER leak to the browser.
      expect(body.error).not.toContain("Prisma");
      expect(body.error).not.toContain("127.0.0.1");
      // Server-side diagnostic log must include enough context to debug.
      expect(consoleSpy).toHaveBeenCalledTimes(1);
    } finally {
      consoleSpy.mockRestore();
    }
  });
});

describe("toSafeScrapeRunStatus", () => {
  it("projects only the safe client-facing fields", () => {
    const safe = toSafeScrapeRunStatus({
      id: "run-1",
      bankId: "popular",
      status: "needs_admin_action",
      startedAt: new Date("2026-06-09T12:00:00.000Z"),
      endedAt: new Date("2026-06-09T12:01:00.000Z"),
      insertedCount: 0,
      skippedCount: 0,
      safeErrorSummary: "Bank session requires admin MFA action",
      createdAt: new Date("2026-06-09T12:00:00.000Z"),
      updatedAt: new Date("2026-06-09T12:01:00.000Z"),
    });

    expect(safe).toEqual({
      id: "run-1",
      bankId: "popular",
      status: "needs_admin_action",
      insertedCount: 0,
      skippedCount: 0,
    });
    // Compile-time guard: the projected object has no unsafe keys.
    expect(Object.keys(safe).sort()).toEqual(
      ["bankId", "id", "insertedCount", "skippedCount", "status"].sort(),
    );
  });
});
