import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createAuthenticatedIngestionProductionResources, type AuthenticatedIngestionProductionResourceFactories } from "./authenticated-ingestion-production-resources";

const config = () => Object.freeze({ databaseUrl: "postgresql://user:secret@db.example:5432/rd", redisUrl: "rediss://user:secret@cache.example:6380/2", redisLockTtlMs: 30_000, redisLockRenewIntervalMs: 10_000, credentialKey: "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff", smtpUrl: "smtps://user:secret@mail.example:465", adminEmail: "ops@example.com" });

function arrange(fail?: "redis" | "repositories" | "transport" | "alert") {
  const order: string[] = [];
  const disconnect = vi.fn(async () => { order.push("prisma-close"); });
  const close = vi.fn(async () => { order.push("lock-close"); });
  const prisma = { $disconnect: disconnect };
  const lock = { acquire: async () => null };
  const resource = { lock, close };
  const repositories = Object.freeze({ authenticationAttempts: { getOrCreate: async () => null, resolveObservedRestoration: async () => null }, autoLoginConfigs: { getByBankCode: async () => null }, credentials: { findAuthenticationMaterialByBankCode: async () => null }, scrapeRuns: { createQueued: async () => null }, transactions: { upsertMany: async () => ({ inserted: 0, skipped: 0 }) }, auditSink: { record: async () => undefined } });
  const transport = { send: vi.fn(async () => undefined) };
  const alertSink = { notifyIngestionAttention: async () => undefined, notifySessionAttention: async () => undefined };
  const factories: AuthenticatedIngestionProductionResourceFactories = {
    createPrismaClient: vi.fn(() => { order.push("prisma"); return prisma as never; }),
    createRedisResource: vi.fn(async (input) => { order.push("redis"); expect(input).toEqual({ redisUrl: config().redisUrl, ttlMs: 30_000, renewIntervalMs: 10_000 }); if (fail === "redis") throw new Error("secret"); return resource; }),
    createRepositories: vi.fn((input) => { order.push("repositories"); expect(input.prisma).toBe(prisma); if (fail === "repositories") throw new Error("secret"); return repositories as never; }),
    createTransport: vi.fn((url) => { order.push("smtp"); expect(url).toBe(config().smtpUrl); if (fail === "transport") throw new Error("secret"); return transport; }),
    createAlertSink: vi.fn((input) => { order.push("alert"); expect(input).toEqual({ transport, recipient: "ops@example.com" }); if (fail === "alert") throw new Error("secret"); return alertSink; }),
  };
  return { alertSink, close, disconnect, factories, lock, order, prisma, transport };
}

describe("createAuthenticatedIngestionProductionResources", () => {
  it("is inert at import and has no production caller or ambient defaults", () => {
    const source = readFileSync(new URL("./authenticated-ingestion-production-resources.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/process\.env|getPrismaClient|ingestion-worker|create.*Processor|browser|queue|activation|setTimeout/);
  });

  it("rejects malformed config before every factory without exposing secrets", async () => {
    const { factories } = arrange();
    const accessor = Object.freeze(Object.defineProperty({ ...config() }, "databaseUrl", { enumerable: true, get: () => "postgresql://secret@db.example/rd" }));
    const invalid = [{ ...config() }, Object.freeze({ ...config(), extra: true }), Object.freeze({ ...config(), [Symbol("x")]: true }), accessor, ...["databaseUrl", "redisUrl", "smtpUrl"].map((field) => Object.freeze({ ...config(), [field]: "http://bad.example/#x" })), Object.freeze({ ...config(), adminEmail: "not-email" }), Object.freeze({ ...config(), credentialKey: "AA==" })];
    for (const value of invalid) await expect(createAuthenticatedIngestionProductionResources(value as never, factories)).rejects.toThrow("Invalid authenticated ingestion production resource configuration.");
    expect(factories.createPrismaClient).not.toHaveBeenCalled();
  });

  it("composes explicit resources in order, preserves URLs, and defers key materialization", async () => {
    const { alertSink, close, disconnect, factories, lock, order, transport } = arrange();
    const resources = await createAuthenticatedIngestionProductionResources(config(), factories);
    expect(order).toEqual(["prisma", "redis", "repositories", "smtp", "alert"]);
    expect(Object.isFrozen(resources)).toBe(true);
    expect(Reflect.ownKeys(resources)).toEqual(["authenticationAttempts", "restorationResolver", "autoLoginConfigs", "credentials", "scrapeRuns", "transactions", "auditSink", "credentialKeyResolver", "bankAuthenticationLock", "alertSink", "closeLock", "closePrisma"]);
    expect(resources).toMatchObject({ bankAuthenticationLock: lock, alertSink });
    expect(resources.closeLock).toBe(close);
    expect(transport.send).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();
    const first = resources.credentialKeyResolver(); first.fill(0);
    expect(resources.credentialKeyResolver().toString("hex")).toBe(config().credentialKey);
  });

  it("keeps shutdown promise identity and fixes close failures", async () => {
    const { close, disconnect, factories } = arrange();
    const resources = await createAuthenticatedIngestionProductionResources(config(), factories);
    expect(resources.closeLock).toBe(close);
    expect(resources.closePrisma()).toBe(resources.closePrisma());
    await resources.closePrisma();
    expect(disconnect).toHaveBeenCalledTimes(1);
    const failing = arrange(); failing.disconnect.mockRejectedValueOnce(new Error("secret"));
    const broken = await createAuthenticatedIngestionProductionResources(config(), failing.factories);
    await expect(broken.closePrisma()).rejects.toThrow("Unable to close authenticated ingestion production resources.");
  });

  it("cleans up reverse-order partial construction failures even when cleanup fails", async () => {
    for (const failure of ["redis", "repositories", "transport", "alert"] as const) {
      const setup = arrange(failure); setup.close.mockRejectedValueOnce(new Error("secret")); setup.disconnect.mockRejectedValueOnce(new Error("secret"));
      await expect(createAuthenticatedIngestionProductionResources(config(), setup.factories)).rejects.toThrow("Unable to create authenticated ingestion production resources.");
      expect(setup.disconnect).toHaveBeenCalledTimes(1);
      if (failure !== "redis") expect(setup.close).toHaveBeenCalledTimes(1);
    }
  });

  it("contains malformed overrides and products with fixed errors and cleanup", async () => {
    const setup = arrange();
    await expect(createAuthenticatedIngestionProductionResources(config(), new Proxy({}, { ownKeys: () => { throw new Error("secret"); } }) as never)).rejects.toThrow("Unable to create authenticated ingestion production resources.");
    await expect(createAuthenticatedIngestionProductionResources(config(), { ...setup.factories, createRepositories: () => ({}) as never })).rejects.toThrow("Unable to create authenticated ingestion production resources.");
    expect(setup.close).toHaveBeenCalledTimes(1);
    expect(setup.disconnect).toHaveBeenCalledTimes(1);
  });
});
