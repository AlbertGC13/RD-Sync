import { describe, expect, it, vi } from "vitest";

import { InMemoryScrapeRunRepository } from "../../../modules/scrape-runs";
import {
  ActiveRunExistsError,
  createRunId,
  scheduleIngestionRunNow,
} from "./run-now";
import type { IngestionJobData, QueueLike } from "../../../worker/queues";
import { InMemoryAuditSink } from "../../../modules/audit";

describe("createRunId", () => {
  it("uses millisecond precision plus a suffix to avoid rapid-click collisions", () => {
    const now = new Date("2026-06-09T12:00:00.123Z");

    const first = createRunId({ bankId: "popular", now });
    const second = createRunId({ bankId: "popular", now });
    const third = createRunId({
      bankId: "popular",
      now: new Date("2026-06-09T12:00:00.124Z"),
    });

    expect(first).toMatch(/^popular-20260609120000123-[a-z0-9]{4}$/);
    expect(new Set([first, second, third]).size).toBe(3);
  });
});

describe("scheduleIngestionRunNow", () => {
  it("creates a queued Popular scrape run and schedules ingestion for admins", async () => {
    const scrapeRuns = new InMemoryScrapeRunRepository();
    const queue = new FakeQueue();

    const result = await scheduleIngestionRunNow(
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
      accountFingerprint: "popular-0000000000",
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
          accountFingerprint: "popular-0000000000",
        },
        options: {
          jobId: "run-popular-now",
          attempts: 3,
          backoff: { type: "exponential", delay: 30_000 },
          removeOnComplete: 100,
          removeOnFail: 250,
        },
      },
    ]);
  });

  it("schedules two admin run-now requests created in the same second", async () => {
    const scrapeRuns = new InMemoryScrapeRunRepository();
    const queue = new FakeQueue();
    const now = () => new Date("2026-06-09T12:00:00.123Z");

    const first = await scheduleIngestionRunNow(
      { principal: { id: "admin-1", role: "admin" } },
      { scrapeRuns, queue, now },
    );
    const second = await scheduleIngestionRunNow(
      { principal: { id: "admin-1", role: "admin" } },
      { scrapeRuns, queue, now },
    );

    expect(first.runId).not.toBe(second.runId);
    expect(await scrapeRuns.list({})).toHaveLength(2);
    expect(queue.addCalls).toHaveLength(2);
  });

  it("allows viewers to schedule runs (authz relaxed for the transactions refresh)", async () => {
    const scrapeRuns = new InMemoryScrapeRunRepository();
    const queue = new FakeQueue();

    const result = await scheduleIngestionRunNow(
      { principal: { id: "viewer-1", role: "viewer" } },
      {
        scrapeRuns,
        queue,
        now: () => new Date("2026-06-09T12:00:00.000Z"),
        createRunId: () => "run-viewer-now",
      },
    );

    expect(result).toMatchObject({
      runId: "run-viewer-now",
      bankId: "popular",
      status: "queued",
    });
    expect(await scrapeRuns.list({})).toHaveLength(1);
    expect(queue.addCalls).toHaveLength(1);
  });

  it("allows reviewers to schedule runs (authz relaxed for the transactions refresh)", async () => {
    const scrapeRuns = new InMemoryScrapeRunRepository();
    const queue = new FakeQueue();

    const result = await scheduleIngestionRunNow(
      { principal: { id: "reviewer-1", role: "reviewer" } },
      {
        scrapeRuns,
        queue,
        now: () => new Date("2026-06-09T12:00:00.000Z"),
        createRunId: () => "run-reviewer-now",
      },
    );

    expect(result).toMatchObject({
      runId: "run-reviewer-now",
      bankId: "popular",
      status: "queued",
    });
    expect(queue.addCalls).toHaveLength(1);
  });

  it("denies unauthenticated requests (null principal) without creating runs or jobs", async () => {
    const scrapeRuns = new InMemoryScrapeRunRepository();
    const queue = new FakeQueue();

    await expect(
      scheduleIngestionRunNow(
        { principal: null },
        { scrapeRuns, queue },
      ),
    ).rejects.toThrow("Authentication required");

    expect(await scrapeRuns.list({})).toEqual([]);
    expect(queue.addCalls).toEqual([]);
  });
});

describe("scheduleIngestionRunNow — audit events", () => {
  it("emits scrape_run.scheduled with the admin actor id and bankId metadata", async () => {
    const auditSink = new InMemoryAuditSink();
    const scrapeRuns = new InMemoryScrapeRunRepository();
    const queue = new FakeQueue();

    await scheduleIngestionRunNow(
      { principal: { id: "admin-1", role: "admin" } },
      {
        scrapeRuns,
        queue,
        now: () => new Date("2026-06-09T12:00:00.000Z"),
        createRunId: () => "run-popular-audit",
        auditSink,
      },
    );

    const events = await auditSink.list();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorId: "admin-1",
      actorRole: "admin",
      action: "scrape_run.scheduled",
      target: "scrape_run",
      targetId: "run-popular-audit",
      metadata: {
        bankId: "popular",
        accountFingerprint: "popular-0000000000",
      },
    });
  });

  it("emits scrape_run.scheduled with the viewer actor id and role when a viewer triggers the run", async () => {
    const auditSink = new InMemoryAuditSink();
    const scrapeRuns = new InMemoryScrapeRunRepository();
    const queue = new FakeQueue();

    await scheduleIngestionRunNow(
      { principal: { id: "viewer-1", role: "viewer" } },
      {
        scrapeRuns,
        queue,
        now: () => new Date("2026-06-09T12:00:00.000Z"),
        createRunId: () => "run-viewer-audit",
        auditSink,
      },
    );

    const events = await auditSink.list();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorId: "viewer-1",
      actorRole: "viewer",
      action: "scrape_run.scheduled",
      target: "scrape_run",
      targetId: "run-viewer-audit",
      metadata: {
        bankId: "popular",
        accountFingerprint: "popular-0000000000",
      },
    });
  });

  it("emits scrape_run.scheduled with the reviewer actor id and role when a reviewer triggers the run", async () => {
    const auditSink = new InMemoryAuditSink();
    const scrapeRuns = new InMemoryScrapeRunRepository();
    const queue = new FakeQueue();

    await scheduleIngestionRunNow(
      { principal: { id: "reviewer-1", role: "reviewer" } },
      {
        scrapeRuns,
        queue,
        now: () => new Date("2026-06-09T12:00:00.000Z"),
        createRunId: () => "run-reviewer-audit",
        auditSink,
      },
    );

    const events = await auditSink.list();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorId: "reviewer-1",
      actorRole: "reviewer",
      action: "scrape_run.scheduled",
      target: "scrape_run",
      targetId: "run-reviewer-audit",
      metadata: {
        bankId: "popular",
        accountFingerprint: "popular-0000000000",
      },
    });
  });

  it("does not emit anything when the request is denied (unauthenticated)", async () => {
    const auditSink = new InMemoryAuditSink();
    const scrapeRuns = new InMemoryScrapeRunRepository();
    const queue = new FakeQueue();

    await expect(
      scheduleIngestionRunNow(
        { principal: null },
        { scrapeRuns, queue, auditSink },
      ),
    ).rejects.toThrow("Authentication required");

    expect(await auditSink.list()).toEqual([]);
  });
});

describe("scheduleIngestionRunNow — supported-bank whitelist", () => {
  it("throws UnsupportedRunNowBankError for a bank that is not in the supported list", async () => {
    const scrapeRuns = new InMemoryScrapeRunRepository();
    const queue = new FakeQueue();

    await expect(
      scheduleIngestionRunNow(
        {
          principal: { id: "admin-1", role: "admin" },
          bankId: "banreservas",
        },
        { scrapeRuns, queue },
      ),
    ).rejects.toThrow(/Unsupported bank for manual run/);

    // No run was queued, no job was scheduled.
    expect(await scrapeRuns.list({})).toEqual([]);
    expect(queue.addCalls).toEqual([]);
  });

  it("records an audit event when the unsupported-bank validation fails", async () => {
    const auditSink = new InMemoryAuditSink();
    const scrapeRuns = new InMemoryScrapeRunRepository();
    const queue = new FakeQueue();

    await expect(
      scheduleIngestionRunNow(
        {
          principal: { id: "admin-1", role: "admin" },
          bankId: "banreservas",
        },
        { scrapeRuns, queue, auditSink },
      ),
    ).rejects.toThrow();

    const events = await auditSink.list();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorId: "admin-1",
      actorRole: "admin",
      action: "scrape_run.unsupported_bank",
      metadata: { bankId: "banreservas" },
    });
  });

  it("accepts the Popular default when bankId is omitted", async () => {
    const scrapeRuns = new InMemoryScrapeRunRepository();
    const queue = new FakeQueue();

    const result = await scheduleIngestionRunNow(
      { principal: { id: "admin-1", role: "admin" } },
      {
        scrapeRuns,
        queue,
        now: () => new Date("2026-06-09T12:00:00.000Z"),
        createRunId: () => "popular-default",
      },
    );

    expect(result.bankId).toBe("popular");
    expect(queue.addCalls).toHaveLength(1);
  });
});

describe("scheduleIngestionRunNow — active-run lock", () => {
  // Wraps an InMemoryScrapeRunRepository with the same list-based
  // hasActiveRunForBank the production route wires, so the lock tests
  // exercise the real detection logic against the repo state.
  function withRealLock(repo: InMemoryScrapeRunRepository) {
    return {
      createQueued: (input: { id: string; bankId: string; createdAt?: Date }) =>
        repo.createQueued(input),
      markFailed: (runId: string, safeErrorSummary: string, endedAt?: Date) =>
        repo.markFailed(runId, safeErrorSummary, endedAt),
      hasActiveRunForBank: async (bankId: string) => {
        const active = await repo.list({ bankId });
        return active.some((run) => run.status === "queued" || run.status === "running");
      },
    };
  }

  it("rejects a new run when an active (queued/running) run already exists for the bank", async () => {
    const repo = new InMemoryScrapeRunRepository();
    // Seed an existing queued run for popular so the lock observes it.
    await repo.createQueued({ id: "existing-run", bankId: "popular" });
    const scrapeRuns = withRealLock(repo);
    const queue = new FakeQueue();

    await expect(
      scheduleIngestionRunNow(
        { principal: { id: "admin-1", role: "admin" }, bankId: "popular" },
        {
          scrapeRuns,
          queue,
          now: () => new Date("2026-06-09T12:00:00.000Z"),
          createRunId: () => "should-not-be-created",
        },
      ),
    ).rejects.toBeInstanceOf(ActiveRunExistsError);

    // No new run was created and no job was scheduled.
    const all = await repo.list({});
    expect(all).toHaveLength(1);
    expect(all[0]?.id).toBe("existing-run");
    expect(queue.addCalls).toEqual([]);
  });

  it("records a scrape_run.duplicate_rejected audit event when the lock rejects", async () => {
    const repo = new InMemoryScrapeRunRepository();
    await repo.createQueued({ id: "existing-run", bankId: "popular" });
    const scrapeRuns = withRealLock(repo);
    const auditSink = new InMemoryAuditSink();
    const queue = new FakeQueue();

    await expect(
      scheduleIngestionRunNow(
        { principal: { id: "admin-1", role: "admin" }, bankId: "popular" },
        {
          scrapeRuns,
          queue,
          auditSink,
          now: () => new Date("2026-06-09T12:00:00.000Z"),
          createRunId: () => "rejected-run",
        },
      ),
    ).rejects.toBeInstanceOf(ActiveRunExistsError);

    const events = await auditSink.list();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorId: "admin-1",
      actorRole: "admin",
      action: "scrape_run.duplicate_rejected",
      metadata: { bankId: "popular" },
    });
  });

  it("schedules the run when hasActiveRunForBank reports no active run", async () => {
    const repo = new InMemoryScrapeRunRepository();
    const scrapeRuns = withRealLock(repo);
    const queue = new FakeQueue();

    const result = await scheduleIngestionRunNow(
      { principal: { id: "admin-1", role: "admin" }, bankId: "popular" },
      {
        scrapeRuns,
        queue,
        now: () => new Date("2026-06-09T12:00:00.000Z"),
        createRunId: () => "fresh-run",
      },
    );

    expect(result.runId).toBe("fresh-run");
    expect(queue.addCalls).toHaveLength(1);
  });

  it("skips the lock when hasActiveRunForBank is not provided (backwards compat)", async () => {
    const scrapeRuns = new InMemoryScrapeRunRepository();
    const queue = new FakeQueue();

    const result = await scheduleIngestionRunNow(
      { principal: { id: "admin-1", role: "admin" }, bankId: "popular" },
      {
        scrapeRuns,
        queue,
        now: () => new Date("2026-06-09T12:00:00.000Z"),
        createRunId: () => "no-lock-run",
      },
    );

    expect(result.runId).toBe("no-lock-run");
    expect(queue.addCalls).toHaveLength(1);
  });
});

describe("scheduleIngestionRunNow — route-by-bankCode (newly enabled run-now banks)", () => {
  it("routes a bhd request through the scheduler with bankId 'bhd' (not fallback to Popular)", async () => {
    const scrapeRuns = new InMemoryScrapeRunRepository();
    const queue = new FakeQueue();

    const result = await scheduleIngestionRunNow(
      {
        principal: { id: "admin-1", role: "admin" },
        bankId: "bhd",
      },
      {
        scrapeRuns,
        queue,
        now: () => new Date("2026-06-09T12:00:00.000Z"),
        createRunId: () => "run-bhd-now",
      },
    );

    expect(result).toEqual({
      runId: "run-bhd-now",
      bankId: "bhd",
      accountFingerprint: "popular-0000000000",
      status: "queued",
    });
    expect(await scrapeRuns.list({})).toMatchObject([
      { id: "run-bhd-now", bankId: "bhd", status: "queued" },
    ]);
    expect(queue.addCalls[0]?.data.bankId).toBe("bhd");
  });

  it("routes a banreservas_personas request through the scheduler with bankId 'banreservas_personas'", async () => {
    const scrapeRuns = new InMemoryScrapeRunRepository();
    const queue = new FakeQueue();

    const result = await scheduleIngestionRunNow(
      {
        principal: { id: "admin-1", role: "admin" },
        bankId: "banreservas_personas",
      },
      {
        scrapeRuns,
        queue,
        now: () => new Date("2026-06-09T12:00:00.000Z"),
        createRunId: () => "run-br-personas",
      },
    );

    expect(result).toMatchObject({
      runId: "run-br-personas",
      bankId: "banreservas_personas",
      status: "queued",
    });
    expect(queue.addCalls[0]?.data.bankId).toBe("banreservas_personas");
  });

  it("routes a banreservas_empresas request through the scheduler with bankId 'banreservas_empresas'", async () => {
    const scrapeRuns = new InMemoryScrapeRunRepository();
    const queue = new FakeQueue();

    const result = await scheduleIngestionRunNow(
      {
        principal: { id: "admin-1", role: "admin" },
        bankId: "banreservas_empresas",
      },
      {
        scrapeRuns,
        queue,
        now: () => new Date("2026-06-09T12:00:00.000Z"),
        createRunId: () => "run-br-empresas",
      },
    );

    expect(result).toMatchObject({
      runId: "run-br-empresas",
      bankId: "banreservas_empresas",
      status: "queued",
    });
    expect(queue.addCalls[0]?.data.bankId).toBe("banreservas_empresas");
  });

  it("does NOT accept unsupported 'banreservas' (must use portal-specific codes)", async () => {
    const scrapeRuns = new InMemoryScrapeRunRepository();
    const queue = new FakeQueue();

    await expect(
      scheduleIngestionRunNow(
        {
          principal: { id: "admin-1", role: "admin" },
          bankId: "banreservas",
        },
        { scrapeRuns, queue },
      ),
    ).rejects.toThrow(/Unsupported bank for manual run/);

    expect(await scrapeRuns.list({})).toEqual([]);
    expect(queue.addCalls).toEqual([]);
  });
});

describe("scheduleIngestionRunNow — queue failure recovery", () => {
  it("marks the persisted run failed with a SAFE summary (no raw queue error) when the queue throws", async () => {
    const scrapeRuns = new InMemoryScrapeRunRepository();
    // Note: redactDiagnosticText targets credential tokens, account numbers,
    // and balance strings. Internal IPs / hostnames are not in scope here —
    // the router is on a private network and the upstream "Redis ECONNREFUSED"
    // string is the only diagnostic surfaced.
    const queue = new FailingQueue(new Error("Redis ECONNREFUSED token=abc123 password=hunter2 account 9999888877"));

    await expect(
      scheduleIngestionRunNow(
        { principal: { id: "admin-1", role: "admin" } },
        {
          scrapeRuns,
          queue,
          now: () => new Date("2026-06-09T12:00:00.000Z"),
          createRunId: () => "run-queue-fail",
        },
      ),
    ).rejects.toThrow(/Redis ECONNREFUSED/);

    const runs = await scrapeRuns.list({});
    expect(runs).toHaveLength(1);
    // The persisted run must NOT remain in `queued` state — that would mislead
    // operators into thinking the worker would pick it up.
    expect(runs[0]).toMatchObject({
      id: "run-queue-fail",
      bankId: "popular",
      status: "failed",
    });
    // The safe summary must have credentials and account numbers redacted.
    expect(runs[0].safeErrorSummary).not.toContain("abc123");
    expect(runs[0].safeErrorSummary).not.toContain("hunter2");
    expect(runs[0].safeErrorSummary).not.toContain("9999888877");
    expect(runs[0].safeErrorSummary).toContain("[REDACTED]");
  });

  it("emits a scrape_run.queue_failed audit event with the redacted summary on queue failure", async () => {
    const auditSink = new InMemoryAuditSink();
    const scrapeRuns = new InMemoryScrapeRunRepository();
    const queue = new FailingQueue(new Error("Redis ECONNREFUSED token=abc123"));

    await expect(
      scheduleIngestionRunNow(
        { principal: { id: "admin-1", role: "admin" } },
        {
          scrapeRuns,
          queue,
          auditSink,
          now: () => new Date("2026-06-09T12:00:00.000Z"),
          createRunId: () => "run-queue-fail-audit",
        },
      ),
    ).rejects.toThrow();

    const events = await auditSink.list();
    const queueEvent = events.find((event) => event.action === "scrape_run.queue_failed");
    expect(queueEvent).toBeDefined();
    expect(queueEvent).toMatchObject({
      actorId: "admin-1",
      actorRole: "admin",
      target: "scrape_run",
      targetId: "run-queue-fail-audit",
      metadata: {
        bankId: "popular",
        safeErrorSummary: expect.stringContaining("[REDACTED]") as unknown as string,
      },
    });
    // The redacted summary stored in the audit metadata must not include
    // the raw token.
    const summary = String(queueEvent?.metadata?.safeErrorSummary ?? "");
    expect(summary).not.toContain("abc123");
  });

  it("re-throws the original queue error even if markFailed also throws", async () => {
    // Repository that lets createQueued succeed but throws on markFailed, to
    // exercise the cascade-handling path inside the queue-failure recovery.
    const partialRepo = new PartialFailingRepository();
    const failingQueue = new FailingQueue(new Error("Redis ECONNREFUSED 127.0.0.1:6379"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await expect(
        scheduleIngestionRunNow(
          { principal: { id: "admin-1", role: "admin" } },
          {
            scrapeRuns: partialRepo,
            queue: failingQueue,
            now: () => new Date("2026-06-09T12:00:00.000Z"),
            createRunId: () => "run-markfailed-throws",
          },
        ),
      ).rejects.toThrow(/Redis ECONNREFUSED/);

      // The server-side log captured the cascading failure for ops.
      expect(consoleSpy).toHaveBeenCalled();
      const callArgs = consoleSpy.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
      expect(callArgs).toBeDefined();
      expect(callArgs).toMatchObject({ runId: "run-markfailed-throws", bankId: "popular" });
    } finally {
      consoleSpy.mockRestore();
    }
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
  readonly addCalls: Array<{
    name: string;
    data: IngestionJobData;
    options: Parameters<QueueLike["add"]>[2];
  }> = [];

  constructor(private readonly error: Error) {}

  async add(): Promise<void> {
    throw this.error;
  }
}

/**
 * Repository that lets createQueued succeed but throws on markFailed, to
 * exercise the cascade-handling path inside the queue-failure recovery.
 */
class PartialFailingRepository {
  private readonly records = new Map<string, { id: string; bankId: string; status: "queued" | "failed"; safeErrorSummary: string | null }>();

  async createQueued(input: { id: string; bankId: string }): Promise<{ status: "queued" }> {
    this.records.set(input.id, { id: input.id, bankId: input.bankId, status: "queued", safeErrorSummary: null });
    return { status: "queued" };
  }

  async markFailed(runId: string): Promise<void> {
    const record = this.records.get(runId);
    if (!record) throw new Error(`Scrape run not found: ${runId}`);
    throw new Error("markFailed boom");
  }
}
