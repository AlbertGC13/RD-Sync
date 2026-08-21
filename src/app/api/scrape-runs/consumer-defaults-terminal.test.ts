import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

describe("default in-memory ingestion consumer", () => {
  it("terminalizes a legacy job without collection dependencies", async () => {
    for (const key of ["__rdSyncIngestionConsumer", "__rdSyncIngestionQueue", "__rdSyncScrapeRunRepository"]) delete (globalThis as Record<string, unknown>)[key];
    vi.resetModules();
    const [{ defaultIngestionConsumer }, { defaultIngestionQueue, defaultScrapeRunRepository, InMemoryScheduledIngestionQueue }] = await Promise.all([import("./consumer-defaults"), import("./defaults")]);
    expect(defaultIngestionQueue).toBeInstanceOf(InMemoryScheduledIngestionQueue);
    const queue = defaultIngestionQueue;
    await defaultScrapeRunRepository.createQueued({ id: "terminal-only-run", bankId: "popular" });
    await queue.add("ingestion", { runId: "terminal-only-run", bankId: "popular", accountFingerprint: "fingerprint" }, {});
    await defaultIngestionConsumer?.drainPending();
    expect((await defaultScrapeRunRepository.findById("terminal-only-run"))?.status).toBe("needs_admin_action");
    const source = await readFile(new URL("./consumer-defaults.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/createIngestionProcessor|defaultTransactionRepository|bankAdapterRegistry|collection-ingestion|browser-runtime/);
  });
});
