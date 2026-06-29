import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET, createGetBankCredentialsHandler } from "./route";
import type { BankCredentialsHandlerDeps } from "./route";
import type { BankCredentialMetadata } from "../../../modules/bank-credentials/repository";

function adminHeaders(): Record<string, string> {
  return { "x-rd-sync-user-id": "admin-1", "x-rd-sync-role": "admin" };
}

function makeRequest(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost:3000${path}`, { headers });
}

function makeHandler(metadata: BankCredentialMetadata | null = null) {
  const service: BankCredentialsHandlerDeps["service"] = {
    getMetadata: vi.fn().mockResolvedValue(metadata),
  };

  return {
    service,
    handler: createGetBankCredentialsHandler({ service }),
  };
}

function clearDefaultCredentialServiceSingletons(): void {
  delete (globalThis as {
    __rdSyncBankCredentialService?: unknown;
    __rdSyncPrismaClient?: unknown;
  }).__rdSyncBankCredentialService;
  delete (globalThis as {
    __rdSyncBankCredentialService?: unknown;
    __rdSyncPrismaClient?: unknown;
  }).__rdSyncPrismaClient;
}

function serializedConsoleCalls(spy: { mock: { calls: unknown[] } }): string {
  return JSON.stringify(spy.mock.calls);
}

async function withDatabaseUrlUnset(act: () => Promise<void>): Promise<void> {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  clearDefaultCredentialServiceSingletons();
  try {
    await act();
  } finally {
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    clearDefaultCredentialServiceSingletons();
  }
}

describe("GET /api/bank-credentials", () => {
  beforeEach(() => {
    process.env.RD_SYNC_TRUST_PROXY_HEADERS = "enabled";
  });

  afterEach(() => {
    delete process.env.RD_SYNC_TRUST_PROXY_HEADERS;
    vi.restoreAllMocks();
  });

  it("returns 401 when unauthenticated", async () => {
    const { handler } = makeHandler();

    const res = await handler(makeRequest("/api/bank-credentials?bankCode=popular"));

    expect(res.status).toBe(401);
  });

  it("returns 403 when caller is not an admin", async () => {
    const { handler } = makeHandler();

    const res = await handler(makeRequest("/api/bank-credentials?bankCode=popular", {
      "x-rd-sync-user-id": "viewer-1",
      "x-rd-sync-role": "viewer",
    }));

    expect(res.status).toBe(403);
  });

  it("returns 400 when bankCode is missing", async () => {
    const { handler } = makeHandler();

    const res = await handler(makeRequest("/api/bank-credentials", adminHeaders()));

    expect(res.status).toBe(400);
  });

  it("returns metadata without secret fields", async () => {
    const metadata = {
      bankCode: "popular",
      isActive: true,
      keyVersion: 1,
      lastRotatedAt: null,
    } satisfies BankCredentialMetadata;
    const { handler, service } = makeHandler(metadata);

    const res = await handler(makeRequest("/api/bank-credentials?bankCode=popular", adminHeaders()));
    const body = await res.json();
    const serialized = JSON.stringify(body);

    expect(res.status).toBe(200);
    expect(service.getMetadata).toHaveBeenCalledWith("popular");
    expect(body).toEqual(metadata);
    expect(serialized).not.toContain("username");
    expect(serialized).not.toContain("password");
    expect(serialized).not.toContain("ciphertext");
    expect(serialized).not.toContain("encrypted");
    expect(serialized).not.toContain("keyMaterial");
    expect(serialized).not.toContain("audit");
  });

  it("returns 404 when credentials are not configured", async () => {
    const { handler } = makeHandler(null);

    const res = await handler(makeRequest("/api/bank-credentials?bankCode=popular", adminHeaders()));

    expect(res.status).toBe(404);
  });

  it("masks service errors", async () => {
    const { handler, service } = makeHandler();
    vi.mocked(service.getMetadata).mockRejectedValue(
      new Error("SENSITIVE_DIAGNOSTIC_SENTINEL"),
    );
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const res = await handler(makeRequest("/api/bank-credentials?bankCode=popular", adminHeaders()));
    const body = await res.json();
    const serialized = JSON.stringify(body);
    const logs = serializedConsoleCalls(consoleSpy);

    expect(res.status).toBe(503);
    expect(body).toEqual({ error: "Unable to retrieve credential metadata" });
    expect(serialized).not.toContain("SENSITIVE_DIAGNOSTIC_SENTINEL");
    expect(logs).toContain("GET /api/bank-credentials");
    expect(logs).toContain("popular");
    expect(logs).not.toContain("SENSITIVE_DIAGNOSTIC_SENTINEL");
    expect(logs).not.toContain("message");
    expect(logs).not.toContain("stack");
  });

  it("does not construct default deps before authz or bankCode validation", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await withDatabaseUrlUnset(async () => {
      await expect(GET(makeRequest("/api/bank-credentials?bankCode=popular")))
        .resolves.toHaveProperty("status", 401);
      await expect(GET(makeRequest("/api/bank-credentials", adminHeaders())))
        .resolves.toHaveProperty("status", 400);
      expect(consoleSpy).not.toHaveBeenCalled();
    });
  });

  it("masks default dependency construction failures", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await withDatabaseUrlUnset(async () => {
      const res = await GET(makeRequest("/api/bank-credentials?bankCode=popular", adminHeaders()));
      const body = await res.json();
      const logs = serializedConsoleCalls(consoleSpy);

      expect(res.status).toBe(503);
      expect(body).toEqual({ error: "Unable to retrieve credential metadata" });
      expect(logs).toContain("GET /api/bank-credentials");
      expect(logs).toContain("popular");
      expect(logs).not.toContain("DATABASE_URL");
      expect(logs).not.toContain("PostgreSQL");
      expect(logs).not.toContain("connection string");
      expect(logs).not.toContain("message");
      expect(logs).not.toContain("stack");
    });
  });
});
