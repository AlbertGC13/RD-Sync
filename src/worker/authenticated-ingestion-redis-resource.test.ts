import { describe, expect, it } from "vitest";
import { createAuthenticatedIngestionRedisResource, type AuthenticatedIngestionRedisResourceFactories } from "./authenticated-ingestion-redis-resource";

type Client = { status: string; eval(): Promise<unknown>; quit(): Promise<void>; disconnect(): void | Promise<void> };
const validConfig = () => Object.freeze({ redisUrl: "rediss://user:secret@cache.example:6380/2?tls=true", ttlMs: 30_000, renewIntervalMs: 10_000 });

function arrange(status = "wait") {
  const calls = { client: 0, store: 0, lock: 0, quit: 0, disconnect: 0, options: undefined as unknown, url: undefined as unknown };
  const client: Client = { status, eval: async () => null, quit: async () => { calls.quit += 1; }, disconnect: () => { calls.disconnect += 1; } };
  const store = { acquireSlot: async () => null, renewIfOwner: async () => false, releaseIfOwner: async () => false };
  const lock = Object.freeze({ acquire: async () => null });
  const factories: AuthenticatedIngestionRedisResourceFactories = {
    createClient: (url, options) => { calls.client += 1; calls.url = url; calls.options = options; return client; },
    createStore: (input) => { calls.store += 1; expect(input).toEqual({ client }); return store; },
    createLock: (input) => { calls.lock += 1; expect(input).toEqual({ store, ttlMs: 30_000, renewIntervalMs: 10_000 }); return lock; },
  };
  return { calls, client, factories, lock };
}

describe("createAuthenticatedIngestionRedisResource", () => {
  it("rejects malformed, mutable, accessor, symbol, and extra configuration before creating a client", async () => {
    const { calls, factories } = arrange();
    const accessor = Object.freeze(Object.defineProperty({ redisUrl: "redis://cache.example", ttlMs: 30_000, renewIntervalMs: 10_000 }, "redisUrl", { enumerable: true, get: () => "redis://cache.example" }));
    const invalid = [
      { redisUrl: "redis://cache.example", ttlMs: 30_000, renewIntervalMs: 10_000 },
      Object.freeze({ redisUrl: "redis://cache.example", ttlMs: 30_000, renewIntervalMs: 10_000, extra: true }),
      Object.freeze({ redisUrl: "redis://cache.example", ttlMs: 30_000, renewIntervalMs: 10_000, [Symbol("extra")]: true }),
      accessor,
      Object.freeze({ redisUrl: "redis://cache.example", ttlMs: 30_000, renewIntervalMs: 30_000 }),
    ];
    for (const config of invalid) await expect(createAuthenticatedIngestionRedisResource(config, factories)).rejects.toThrow("Invalid authenticated ingestion Redis resource configuration.");
    expect(calls.client).toBe(0);
  });

  it("preserves valid Redis URLs and creates a lazy client without commands", async () => {
    for (const redisUrl of ["redis://user:pass@cache.example:6379/3?name=worker", "rediss://user:pass@cache.example:6380/3?tls=true"]) {
      const { calls, factories } = arrange();
      await createAuthenticatedIngestionRedisResource(Object.freeze({ redisUrl, ttlMs: 30_000, renewIntervalMs: 10_000 }), factories);
      expect(calls).toMatchObject({ client: 1, url: redisUrl, options: { lazyConnect: true, maxRetriesPerRequest: 3, connectTimeout: 5000, commandTimeout: 5000 } });
    }
  });

  it("returns only a frozen lock and close function", async () => {
    const { factories, lock } = arrange();
    const resource = await createAuthenticatedIngestionRedisResource(validConfig(), factories);
    expect(Object.isFrozen(resource)).toBe(true);
    expect(Reflect.ownKeys(resource)).toEqual(["lock", "close"]);
    expect(resource.lock).toBe(lock);
  });

  it("disconnects wait and terminal clients, but quits ready clients", async () => {
    for (const status of ["wait", "end", "close"]) {
      const { calls, factories } = arrange(status);
      await (await createAuthenticatedIngestionRedisResource(validConfig(), factories)).close();
      expect(calls).toMatchObject({ quit: 0, disconnect: 1 });
    }
    const { calls, factories } = arrange("ready");
    await (await createAuthenticatedIngestionRedisResource(validConfig(), factories)).close();
    expect(calls).toMatchObject({ quit: 1, disconnect: 0 });
  });

  it("falls back to disconnect, protects concurrent close identity, and returns a safe error", async () => {
    const { calls, client, factories } = arrange("ready");
    client.quit = async () => { calls.quit += 1; throw new Error("secret"); };
    const resource = await createAuthenticatedIngestionRedisResource(validConfig(), factories);
    expect(resource.close()).toBe(resource.close());
    await resource.close();
    expect(calls).toMatchObject({ quit: 1, disconnect: 1 });

    client.disconnect = () => { calls.disconnect += 1; throw new Error("secret"); };
    const failing = await createAuthenticatedIngestionRedisResource(validConfig(), factories);
    await expect(failing.close()).rejects.toThrow("Unable to close authenticated ingestion Redis resource.");
  });

  it("disconnects when status access fails and cleans up partial construction without leaking details", async () => {
    const { calls, client, factories } = arrange();
    Object.defineProperty(client, "status", { get: () => { throw new Error("redis://secret@host"); } });
    await (await createAuthenticatedIngestionRedisResource(validConfig(), factories)).close();
    expect(calls.disconnect).toBe(1);

    const unreadable = arrange();
    Object.defineProperty(unreadable.client, "status", { get: () => { throw new Error("secret"); } });
    unreadable.client.disconnect = () => { unreadable.calls.disconnect += 1; throw new Error("secret"); };
    await expect((await createAuthenticatedIngestionRedisResource(validConfig(), unreadable.factories)).close()).rejects.toThrow("Unable to close authenticated ingestion Redis resource.");

    const broken = arrange();
    await expect(createAuthenticatedIngestionRedisResource(validConfig(), { ...broken.factories, createStore: () => { throw new Error("redis://secret@host"); } })).rejects.toThrow("Unable to create authenticated ingestion Redis resource.");
    expect(broken.calls).toMatchObject({ client: 1, disconnect: 1, quit: 0 });

    const brokenLock = arrange();
    await expect(createAuthenticatedIngestionRedisResource(validConfig(), { ...brokenLock.factories, createLock: () => { throw new Error("secret"); } })).rejects.toThrow("Unable to create authenticated ingestion Redis resource.");
    expect(brokenLock.calls).toMatchObject({ client: 1, disconnect: 1, quit: 0 });
  });

  it("rejects invalid URL boundaries without echoing credentials", async () => {
    const { calls, factories } = arrange();
    for (const redisUrl of ["http://cache.example", "redis:///0", "redis://cache.example:99999", "redis://cache.example/#fragment", "redis://user:secret@cache.example/\n"]) {
      await expect(createAuthenticatedIngestionRedisResource(Object.freeze({ redisUrl, ttlMs: 30_000, renewIntervalMs: 10_000 }), factories)).rejects.toThrow("Invalid authenticated ingestion Redis resource configuration.");
    }
    expect(calls.client).toBe(0);
  });
});
