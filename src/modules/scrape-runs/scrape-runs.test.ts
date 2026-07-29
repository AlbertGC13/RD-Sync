import { describe, expect, it } from "vitest";

import {
  InMemoryScrapeRunRepository,
  filterScrapeRuns,
  toDashboardScrapeRun,
} from "./index";
import type { ScrapeRunRecord } from "./index";
import { runScrapeRunRepositoryContract } from "../persistence/contracts/scrape-run-repository.contract";

const baseRun: ScrapeRunRecord = {
  id: "run-1",
  bankId: "popular",
  status: "queued",
  startedAt: null,
  endedAt: null,
  insertedCount: 0,
  skippedCount: 0,
  safeErrorSummary: null,
  createdAt: new Date("2026-06-08T12:00:00.000Z"),
  updatedAt: new Date("2026-06-08T12:00:00.000Z"),
};

describe("filterScrapeRuns", () => {
  const records: ScrapeRunRecord[] = [
    {
      ...baseRun,
      id: "run-newest",
      bankId: "popular",
      status: "needs_admin_action",
      createdAt: new Date("2026-06-08T15:00:00.000Z"),
    },
    {
      ...baseRun,
      id: "run-middle",
      bankId: "bhd",
      status: "succeeded",
      createdAt: new Date("2026-06-08T14:00:00.000Z"),
    },
    {
      ...baseRun,
      id: "run-oldest",
      bankId: "popular",
      status: "failed",
      createdAt: new Date("2026-06-07T13:00:00.000Z"),
    },
  ];

  it("returns newest-first scrape runs matching bank and status filters", () => {
    const result = filterScrapeRuns(records, {
      bankId: "popular",
      status: "needs_admin_action",
    });

    expect(result.map((run) => run.id)).toEqual(["run-newest"]);
  });

  it("filters runs by created date range without leaking unrelated records", () => {
    const result = filterScrapeRuns(records, {
      dateFrom: "2026-06-08T00:00:00.000Z",
      dateTo: "2026-06-08T23:59:59.999Z",
    });

    expect(result.map((run) => run.id)).toEqual(["run-newest", "run-middle"]);
  });
});

describe("toDashboardScrapeRun", () => {
  it("removes internal timestamps while keeping safe admin-facing fields", () => {
    expect(
      toDashboardScrapeRun({
        ...baseRun,
        status: "failed",
        startedAt: new Date("2026-06-08T12:01:00.000Z"),
        endedAt: new Date("2026-06-08T12:02:00.000Z"),
        safeErrorSummary: "Transaction table selector missing",
      }),
    ).toEqual({
      id: "run-1",
      bankId: "popular",
      status: "failed",
      startedAt: "2026-06-08T12:01:00.000Z",
      endedAt: "2026-06-08T12:02:00.000Z",
      insertedCount: 0,
      skippedCount: 0,
      safeErrorSummary: "Transaction table selector missing",
    });
  });
});

describe("InMemoryScrapeRunRepository", () => {
  it("creates queued runs and lists them newest first", async () => {
    const repository = new InMemoryScrapeRunRepository();

    await repository.createQueued({
      id: "run-old",
      bankId: "popular",
      createdAt: new Date("2026-06-08T12:00:00.000Z"),
    });
    await repository.createQueued({
      id: "run-new",
      bankId: "popular",
      createdAt: new Date("2026-06-08T13:00:00.000Z"),
    });

    expect((await repository.list({})).map((run) => run.id)).toEqual(["run-new", "run-old"]);
  });

  it("findById returns the matching run and null when absent", async () => {
    const repository = new InMemoryScrapeRunRepository();

    await repository.createQueued({ id: "run-a", bankId: "popular" });
    await repository.markSucceeded(
      "run-a",
      { insertedCount: 5, skippedCount: 2 },
      new Date("2026-06-08T12:05:00.000Z"),
    );

    const found = await repository.findById("run-a");
    expect(found).toMatchObject({
      id: "run-a",
      bankId: "popular",
      status: "succeeded",
      insertedCount: 5,
      skippedCount: 2,
    });

    // Missing run resolves to null — the status endpoint maps this to 404.
    expect(await repository.findById("does-not-exist")).toBeNull();
  });

  it("findById returns a copy so callers cannot mutate repository state", async () => {
    const repository = new InMemoryScrapeRunRepository();
    await repository.createQueued({ id: "run-a", bankId: "popular" });

    const found = await repository.findById("run-a");
    expect(found).not.toBeNull();
    found!.status = "succeeded";

    // The internal record must be untouched — defensive copy on read.
    expect((await repository.findById("run-a"))?.status).toBe("queued");
  });

  it("findById clones Date fields so in-place mutation does not leak into stored state", async () => {
    const repository = new InMemoryScrapeRunRepository();
    await repository.createQueued({
      id: "run-dates",
      bankId: "popular",
      createdAt: new Date("2026-06-08T12:00:00.000Z"),
    });
    await repository.markRunning("run-dates", new Date("2026-06-08T12:01:00.000Z"));

    const found = await repository.findById("run-dates");
    expect(found).not.toBeNull();
    // Capture the pristine stored time values before any mutation.
    const originalCreatedAt = found!.createdAt.getTime();
    const originalUpdatedAt = found!.updatedAt.getTime();
    const originalStartedAt = found!.startedAt?.getTime();

    // Mutate the returned Date objects IN PLACE (not just reassigning the
    // property) — this is the subtle bug a shallow `{ ...record }` copy would
    // let through, because the Date refs would be shared with the stored record.
    found!.createdAt.setTime(originalCreatedAt + 3_600_000);
    found!.updatedAt.setTime(originalUpdatedAt + 3_600_000);
    found!.startedAt?.setTime((originalStartedAt ?? 0) + 3_600_000);

    const after = await repository.findById("run-dates");
    expect(after!.createdAt.getTime()).toBe(originalCreatedAt);
    expect(after!.updatedAt.getTime()).toBe(originalUpdatedAt);
    expect(after!.startedAt?.getTime()).toBe(originalStartedAt);
  });

  it("records worker status transitions with timestamps and counts", async () => {
    const repository = new InMemoryScrapeRunRepository();

    await repository.createQueued({
      id: "run-1",
      bankId: "popular",
      createdAt: new Date("2026-06-08T12:00:00.000Z"),
    });
    await repository.markRunning("run-1", new Date("2026-06-08T12:01:00.000Z"));
    await repository.markSucceeded(
      "run-1",
      { insertedCount: 3, skippedCount: 1 },
      new Date("2026-06-08T12:02:00.000Z"),
    );

    expect(await repository.list({ status: "succeeded" })).toMatchObject([
      {
        id: "run-1",
        bankId: "popular",
        status: "succeeded",
        insertedCount: 3,
        skippedCount: 1,
        startedAt: new Date("2026-06-08T12:01:00.000Z"),
        endedAt: new Date("2026-06-08T12:02:00.000Z"),
      },
    ]);
  });

  it("records MFA/admin-action and failure summaries safely", async () => {
    const repository = new InMemoryScrapeRunRepository();

    await repository.createQueued({ id: "run-mfa", bankId: "popular" });
    await repository.createQueued({ id: "run-failed", bankId: "popular" });
    await repository.markNeedsAdminAction(
      "run-mfa",
      "Bank session requires admin MFA action",
      new Date("2026-06-08T12:03:00.000Z"),
    );
    await repository.markFailed(
      "run-failed",
      "Transaction table selector missing",
      new Date("2026-06-08T12:04:00.000Z"),
    );

    const attentionRuns = await repository.list({ bankId: "popular" });

    expect(attentionRuns.map((run) => [run.id, run.status, run.safeErrorSummary])).toEqual([
      ["run-failed", "failed", "Transaction table selector missing"],
      ["run-mfa", "needs_admin_action", "Bank session requires admin MFA action"],
    ]);
  });

  it("persists browser throttling as a distinct deferred outcome", async () => {
    const repository = new InMemoryScrapeRunRepository();

    await repository.createQueued({ id: "run-throttled", bankId: "popular" });
    await repository.markThrottled(
      "run-throttled",
      "Bank browser capacity is temporarily unavailable",
      new Date("2026-06-08T12:05:00.000Z"),
    );

    expect(await repository.list({ status: "throttled" })).toMatchObject([
      {
        id: "run-throttled",
        status: "throttled",
        safeErrorSummary: "Bank browser capacity is temporarily unavailable",
        endedAt: new Date("2026-06-08T12:05:00.000Z"),
      },
    ]);
    expect(await repository.list({ status: "needs_admin_action" })).toEqual([]);
  });
});

runScrapeRunRepositoryContract(async () => ({
  repo: new InMemoryScrapeRunRepository(),
  cleanup: async () => undefined,
}));
