import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { activateAuthenticatedIngestionProduction } from "./authenticated-ingestion-production-activation";
import { createIngestionWorkerShutdown } from "./ingestion-worker-shutdown";

const enabledEnv = Object.freeze({
  RD_SYNC_AUTHENTICATED_INGESTION: "enabled",
  DATABASE_URL: "postgresql://user:secret@db.example:5432/rd",
  RD_SYNC_REDIS_URL: "rediss://user:secret@cache.example:6380/2",
  RD_SYNC_BANK_CREDENTIAL_KEY: "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
  RD_SYNC_ALERT_SMTP_URL: "smtps://user:secret@mail.example:465",
  RD_SYNC_ADMIN_EMAIL: "ops@example.com",
  RD_SYNC_AUTHENTICATED_INGESTION_LOCK_TTL_MS: "30000",
  RD_SYNC_AUTHENTICATED_INGESTION_LOCK_RENEW_INTERVAL_MS: "10000",
});

describe("activateAuthenticatedIngestionProduction", () => {
  it("keeps legacy processor construction inside the composition-root legacy factory", async () => {
    const source = await readFile(new URL("./ingestion-worker.ts", import.meta.url), "utf8");

    expect(source).toMatch(/createLegacy:\s*\(\)\s*=>\s*createIngestionProcessor\(/);
    expect(source).not.toContain("const legacyProcessor = createIngestionProcessor");
  });

  it.each([undefined, "", "true", "Enabled", "enabled "])("keeps legacy processing isolated for %j", async (activation) => {
    const createLegacy = vi.fn(() => "legacy");
    const loadProduction = vi.fn();

    await expect(activateAuthenticatedIngestionProduction({
      env: { ...enabledEnv, RD_SYNC_AUTHENTICATED_INGESTION: activation },
      createLegacy,
      loadProduction,
    })).resolves.toEqual({ kind: "legacy", processor: "legacy" });

    expect(createLegacy).toHaveBeenCalledOnce();
    expect(loadProduction).not.toHaveBeenCalled();
  });

  it("creates the owned production bundle and processor only for the exact enabled value", async () => {
    const resources = { closeLock: vi.fn(), closePrisma: vi.fn() };
    const createResources = vi.fn(async () => resources);
    const createProcessor = vi.fn(() => "authenticated");
    const loadProduction = vi.fn(async () => ({ createResources, createProcessor }));

    const result = await activateAuthenticatedIngestionProduction({ env: enabledEnv, createLegacy: vi.fn(() => "legacy"), loadProduction });

    expect(result).toEqual({ kind: "authenticated", processor: "authenticated", closeLock: resources.closeLock, closePrisma: resources.closePrisma });
    expect(createResources).toHaveBeenCalledWith({ databaseUrl: enabledEnv.DATABASE_URL, redisUrl: enabledEnv.RD_SYNC_REDIS_URL, credentialKey: enabledEnv.RD_SYNC_BANK_CREDENTIAL_KEY, smtpUrl: enabledEnv.RD_SYNC_ALERT_SMTP_URL, adminEmail: enabledEnv.RD_SYNC_ADMIN_EMAIL, redisLockTtlMs: 30000, redisLockRenewIntervalMs: 10000 });
    expect(createProcessor).toHaveBeenCalledWith(resources);
  });

  it("fails closed without constructing legacy processing when enabled configuration or production construction fails", async () => {
    const createLegacy = vi.fn(() => "legacy");
    const loadProduction = vi.fn(async () => { throw new Error("secret"); });

    await expect(activateAuthenticatedIngestionProduction({ env: { ...enabledEnv, DATABASE_URL: "" }, createLegacy, loadProduction })).rejects.toThrow("Authenticated ingestion production activation failed.");
    await expect(activateAuthenticatedIngestionProduction({ env: enabledEnv, createLegacy, loadProduction })).rejects.toThrow("Authenticated ingestion production activation failed.");
    expect(createLegacy).not.toHaveBeenCalled();
  });

  it("closes owned lock and Prisma once after the worker closes", async () => {
    const calls: string[] = [];
    const resources = { closeLock: vi.fn(async () => { calls.push("lock"); }), closePrisma: vi.fn(async () => { calls.push("prisma"); }) };
    const activated = await activateAuthenticatedIngestionProduction({
      env: enabledEnv,
      createLegacy: vi.fn(() => "legacy"),
      loadProduction: async () => ({ createResources: async () => resources, createProcessor: () => "authenticated" }),
    });
    if (activated.kind !== "authenticated") throw new Error("expected authenticated activation");
    const shutdown = createIngestionWorkerShutdown({
      timeoutMs: 100,
      worker: { pauseIntake: async () => { calls.push("pause"); }, abortActive: () => { calls.push("abort"); }, awaitActiveDrain: async () => {}, gracefulClose: async () => { calls.push("close"); }, forceClose: async () => { calls.push("force"); } },
      hooks: { closeLock: activated.closeLock, closePrisma: activated.closePrisma },
    });

    await Promise.all([shutdown(), shutdown()]);

    expect(calls).toEqual(["pause", "abort", "close", "lock", "prisma"]);
    expect(resources.closeLock).toHaveBeenCalledOnce();
    expect(resources.closePrisma).toHaveBeenCalledOnce();
  });
});
