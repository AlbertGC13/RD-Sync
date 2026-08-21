import { describe, expect, it, vi } from "vitest";

describe("default in-memory ingestion consumer", () => {
  it("terminalizes a legacy job without collection dependencies", async () => {
    for (const key of ["__rdSyncIngestionConsumer", "__rdSyncIngestionConsumerInitialized", "__rdSyncIngestionQueue", "__rdSyncScrapeRunRepository"]) delete (globalThis as Record<string, unknown>)[key];
    vi.resetModules();
    const [{ defaultIngestionConsumer }, { defaultIngestionQueue, defaultScrapeRunRepository, InMemoryScheduledIngestionQueue }] = await Promise.all([import("./consumer-defaults"), import("./defaults")]);
    expect(defaultIngestionQueue).toBeInstanceOf(InMemoryScheduledIngestionQueue);
    const queue = defaultIngestionQueue;
    await defaultScrapeRunRepository.createQueued({ id: "terminal-only-run", bankId: "popular" });
    await queue.add("ingestion", { runId: "terminal-only-run", bankId: "popular", accountFingerprint: "fingerprint" }, {});
    await defaultIngestionConsumer?.drainPending();
    expect((await defaultScrapeRunRepository.findById("terminal-only-run"))?.status).toBe("needs_admin_action");
  });

  it("loads terminal defaults without evaluating forbidden runtime boundaries", async () => {
    for (const key of ["__rdSyncIngestionConsumer", "__rdSyncIngestionConsumerInitialized", "__rdSyncIngestionQueue", "__rdSyncScrapeRunRepository"]) delete (globalThis as Record<string, unknown>)[key];
    vi.resetModules();
    const forbidden = ["./scraper-defaults", "../transactions/defaults", "../../../worker/queues", "../../../worker/authenticated-ingestion-composition"];
    const evaluations = new Map(forbidden.map((path) => [path, 0]));
    for (const path of forbidden) vi.doMock(path, () => { evaluations.set(path, evaluations.get(path)! + 1); throw new Error(`forbidden module evaluated: ${path}`); });
    try {
      const { defaultIngestionConsumer } = await import("./consumer-defaults");
      const { defaultIngestionQueue, defaultScrapeRunRepository, InMemoryScheduledIngestionQueue } = await import("./defaults");
      expect(defaultIngestionQueue).toBeInstanceOf(InMemoryScheduledIngestionQueue);
      expect([...evaluations.values()]).toEqual([0, 0, 0, 0]);
      await defaultScrapeRunRepository.createQueued({ id: "v1-terminal-run", bankId: "popular" });
      await defaultIngestionQueue.add("ingestion", { runId: "v1-terminal-run", bankId: "popular", accountFingerprint: "fingerprint", authentication: { version: 1, attemptId: "attempt" } }, {});
      await defaultIngestionConsumer?.drainPending();
      expect((await defaultScrapeRunRepository.findById("v1-terminal-run"))?.status).toBe("needs_admin_action");
    } finally {
      for (const path of forbidden) vi.doUnmock(path);
    }
  });
});
