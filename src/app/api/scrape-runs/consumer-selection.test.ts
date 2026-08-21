import { describe, expect, it } from "vitest";
import {
  AUTHENTICATED_INGESTION_REDIS_REQUIRED,
  IN_MEMORY_INGESTION_RUNTIME_UNAVAILABLE,
  createIngestionConsumerSelector,
} from "./consumer-selection";

function selector(env: Record<string, string | undefined>, loader = async () => ({ createDefaultInMemoryIngestionConsumer: () => ({ drainPending: async () => [] }) })) {
  return createIngestionConsumerSelector({ env, loadDisabledRuntime: loader });
}

describe("in-memory ingestion consumer selection", () => {
  it("refuses exact enabled without a nonblank Redis URL before loading runtime", async () => {
    let loads = 0;
    await expect(selector({ RD_SYNC_AUTHENTICATED_INGESTION: "enabled", RD_SYNC_REDIS_URL: "  " }, async () => { loads += 1; throw new Error("unexpected"); })())
      .rejects.toThrow(AUTHENTICATED_INGESTION_REDIS_REQUIRED);
    expect(loads).toBe(0);
  });

  it("leaves Redis modes to the separate worker without loading the in-memory runtime", async () => {
    let loads = 0;
    const loader = async () => { loads += 1; return { createDefaultInMemoryIngestionConsumer: () => ({ drainPending: async () => [] }) }; };
    await expect(selector({ RD_SYNC_AUTHENTICATED_INGESTION: "enabled", RD_SYNC_REDIS_URL: "redis://worker" }, loader)()).resolves.toBeUndefined();
    await expect(selector({ RD_SYNC_REDIS_URL: "redis://worker" }, loader)()).resolves.toBeUndefined();
    expect(loads).toBe(0);
  });

  it("loads and caches only the disabled terminal runtime", async () => {
    let loads = 0;
    const consumer = { drainPending: async () => [] };
    const select = selector({}, async () => { loads += 1; return { createDefaultInMemoryIngestionConsumer: () => consumer }; });
    expect(await select()).toBe(consumer);
    expect(await select()).toBe(consumer);
    expect(loads).toBe(1);
  });

  it.each(["enabled ", "ENABLED", "true", "1", "", " disabled"])("keeps hostile activation value %j disabled", async (activation) => {
    let loads = 0;
    await selector({ RD_SYNC_AUTHENTICATED_INGESTION: activation }, async () => { loads += 1; return { createDefaultInMemoryIngestionConsumer: () => ({ drainPending: async () => [] }) }; })();
    expect(loads).toBe(1);
  });

  it("uses one pending load for concurrent disabled calls", async () => {
    let loads = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const select = selector({}, async () => { loads += 1; await gate; return { createDefaultInMemoryIngestionConsumer: () => ({ drainPending: async () => [] }) }; });
    const pending = Promise.all([select(), select()]);
    release?.();
    const [first, second] = await pending;
    expect(loads).toBe(1);
    expect(first).toBe(second);
  });

  it("returns a fixed error and retries after a failed load", async () => {
    let loads = 0;
    const select = selector({}, async () => {
      loads += 1;
      if (loads === 1) throw new Error("redis://secret");
      return { createDefaultInMemoryIngestionConsumer: () => ({ drainPending: async () => [] }) };
    });
    await expect(select()).rejects.toThrow(IN_MEMORY_INGESTION_RUNTIME_UNAVAILABLE);
    await expect(select()).resolves.toBeDefined();
    expect(loads).toBe(2);
  });
});
