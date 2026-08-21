import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Registry = typeof globalThis & {
  __rdSyncIngestionConsumer?: unknown;
  __rdSyncIngestionConsumerInitialized?: boolean;
  __rdSyncIngestionQueue?: unknown;
  __rdSyncScrapeRunRepository?: unknown;
  __rdSyncBrowserCapacityMonitor?: unknown;
};

function clearDefaultSingletons() {
  const registry = globalThis as Registry;
  delete registry.__rdSyncIngestionConsumer;
  delete registry.__rdSyncIngestionConsumerInitialized;
  delete registry.__rdSyncIngestionQueue;
  delete registry.__rdSyncScrapeRunRepository;
  delete registry.__rdSyncBrowserCapacityMonitor;
}

async function loadDefaults() {
  const defaults = await import("./defaults");
  const consumerDefaults = await import("./consumer-defaults");
  return { ...defaults, ...consumerDefaults };
}

describe("default ingestion consumer activation", () => {
  beforeEach(() => {
    vi.resetModules();
    clearDefaultSingletons();
    delete process.env.DATABASE_URL;
    delete process.env.RD_SYNC_REDIS_URL;
    delete process.env.RD_SYNC_AUTHENTICATED_INGESTION;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    clearDefaultSingletons();
  });

  it("leaves consumption to the separate worker when exact activation has Redis", async () => {
    vi.stubEnv("RD_SYNC_AUTHENTICATED_INGESTION", "enabled");
    vi.stubEnv("RD_SYNC_REDIS_URL", "redis://worker:6379");

    const { defaultIngestionConsumer } = await loadDefaults();

    expect(defaultIngestionConsumer).toBeUndefined();
  });

  it("refuses exact activation without Redis before creating an in-memory consumer", async () => {
    vi.stubEnv("RD_SYNC_AUTHENTICATED_INGESTION", "enabled");

    await expect(loadDefaults()).rejects.toThrow("Authenticated ingestion requires a Redis worker.");
    expect((globalThis as Registry).__rdSyncIngestionConsumerInitialized).toBeUndefined();
  });

  it.each([undefined, "Enabled", " enabled", "enabled ", "true", "disabled"])
  ("uses the telemetry-backed disabled terminal processor without Redis for activation %p", async (activation) => {
    if (activation !== undefined) vi.stubEnv("RD_SYNC_AUTHENTICATED_INGESTION", activation);
    const { defaultIngestionConsumer, defaultIngestionQueue, defaultScrapeRunRepository } = await loadDefaults();
    const consumer = defaultIngestionConsumer!;

    await defaultScrapeRunRepository.createQueued({ id: "run-v1", bankId: "popular", createdAt: new Date() });
    await defaultScrapeRunRepository.createQueued({ id: "run-legacy", bankId: "popular", createdAt: new Date() });

    await defaultIngestionQueue.add("bank-transaction-ingestion", {
      runId: "run-v1",
      bankId: "popular",
      accountFingerprint: "fingerprint",
      authentication: { version: 1, attemptId: "attempt" },
    }, { jobId: "run-v1", attempts: 1 });
    await defaultIngestionQueue.add("bank-transaction-ingestion", {
      runId: "run-legacy",
      bankId: "popular",
      accountFingerprint: "fingerprint",
    }, { jobId: "run-legacy", attempts: 1 });

    await expect(consumer.drainPending()).resolves.toEqual([
      { status: "needs_admin_action", inserted: 0, skipped: 0 },
      { status: "needs_admin_action", inserted: 0, skipped: 0 },
    ]);
  });

  it("keeps disabled deliveries out of the API process when Redis is configured", async () => {
    vi.stubEnv("RD_SYNC_AUTHENTICATED_INGESTION", "Enabled");
    vi.stubEnv("RD_SYNC_REDIS_URL", "redis://worker:6379");

    const { defaultIngestionConsumer } = await loadDefaults();

    expect(defaultIngestionConsumer).toBeUndefined();
  });

});
