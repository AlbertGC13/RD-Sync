import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET, POST, createGetBankCredentialsHandler, createPostBankCredentialsHandler } from "./route";
import type { GetBankCredentialsHandlerDeps, PostBankCredentialsHandlerDeps } from "./route";
import type { BankCredentialMetadata } from "../../../modules/bank-credentials/repository";
import { InMemoryRateLimiter, type RateLimiter } from "../../../modules/auth/rate-limiter";

function adminHeaders(): Record<string, string> {
  return { "x-rd-sync-user-id": "admin-1", "x-rd-sync-role": "admin" };
}

function makeRequest(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost:3000${path}`, { headers });
}

function makeHandler(metadata: BankCredentialMetadata | null = null) {
  const service = {
    getMetadata: vi.fn().mockResolvedValue(metadata),
  } satisfies GetBankCredentialsHandlerDeps["service"];

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

function passThroughRateLimiter(): RateLimiter {
  return { check: () => ({ allowed: true }), recordFailure: () => undefined };
}

function trackingRateLimiter(): RateLimiter & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    check: (key: string) => { calls.push(`check:${key}`); return { allowed: true }; },
    recordFailure: (key: string) => { calls.push(`fail:${key}`); },
  };
}

function postBody(body: unknown, headers: Record<string, string> = adminHeaders()): Request {
  return new Request("http://localhost:3000/api/bank-credentials", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function makePostHandler(
  serviceOverrides: Partial<PostBankCredentialsHandlerDeps["service"]> = {},
  rateLimiter: RateLimiter = passThroughRateLimiter(),
) {
  const service: PostBankCredentialsHandlerDeps["service"] = {
    setOrRotate: vi.fn().mockResolvedValue({ bankCode: "popular", keyVersion: 1, action: "set" }),
    validateStoredCredentialDecryption: vi.fn().mockResolvedValue({ bankCode: "popular", outcome: "decrypted" }),
    ...serviceOverrides,
  };

  return { service, handler: createPostBankCredentialsHandler({ service, rateLimiter }) };
}

describe("POST /api/bank-credentials", () => {
  beforeEach(() => {
    process.env.RD_SYNC_TRUST_PROXY_HEADERS = "enabled";
  });

  afterEach(() => {
    delete process.env.RD_SYNC_TRUST_PROXY_HEADERS;
    vi.restoreAllMocks();
  });

  it.each([{ headers: {} as Record<string, string>, status: 401 }, { headers: { "x-rd-sync-user-id": "viewer-1", "x-rd-sync-role": "viewer" }, status: 403 }])(
    "rejects POST caller without admin access ($status)", async ({ headers, status }) => {
      const { handler } = makePostHandler();
      const res = await handler(postBody({ bankCode: "popular", action: "set", username: "u", password: "p" }, headers));
      expect(res.status).toBe(status);
    });

  it("rate-limits POST attempts per actor and resets after the window", async () => {
    let now = 1_000;
    const limiter = new InMemoryRateLimiter({ maxAttempts: 10, windowMs: 60_000, clock: () => now });
    const { handler } = makePostHandler({}, limiter);

    for (let i = 0; i < 10; i += 1) {
      await expect(handler(postBody({ bankCode: "popular", action: "test" }))).resolves.toHaveProperty("status", 200);
    }
    const blocked = await handler(postBody({ bankCode: "popular", action: "test" }));
    const otherActor = await handler(postBody({ bankCode: "popular", action: "test" }, { "x-rd-sync-user-id": "admin-2", "x-rd-sync-role": "admin" }));

    now += 60_000;
    const reset = await handler(postBody({ bankCode: "popular", action: "test" }));

    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBe("60");
    expect(otherActor.status).toBe(200);
    expect(reset.status).toBe(200);
  });

  it("rate-limits concurrent POST attempts before service resolves", async () => {
    const limiter = new InMemoryRateLimiter({ maxAttempts: 10, windowMs: 60_000, clock: () => 1_000 });
    let release!: (value: { bankCode: string; outcome: "decrypted" }) => void;
    const gate = new Promise<{ bankCode: string; outcome: "decrypted" }>((resolve) => { release = resolve; });
    const { handler, service } = makePostHandler({
      validateStoredCredentialDecryption: vi.fn(() => gate),
    }, limiter);

    const attempts = Array.from({ length: 11 }, () => handler(postBody({ bankCode: "popular", action: "test" })));
    const blocked = await attempts[10];
    release({ bankCode: "popular", outcome: "decrypted" });

    expect(blocked.status).toBe(429);
    expect((await Promise.all(attempts.slice(0, 10))).map((res) => res.status)).toEqual(Array(10).fill(200));
    expect(service.validateStoredCredentialDecryption).toHaveBeenCalledTimes(10);
  });

  it("returns 400 when body is not valid JSON", async () => {
    const { handler } = makePostHandler();
    const res = await handler(new Request("http://localhost:3000/api/bank-credentials", {
      method: "POST",
      headers: { "content-type": "application/json", ...adminHeaders() },
      body: "not-json",
    }));
    expect(res.status).toBe(400);
  });

  it.each([null, [], "primitive", 7, true])(
    "returns 400 and records an attempt for invalid JSON shape %#",
    async (body) => {
      const limiter = trackingRateLimiter();
      const { handler, service } = makePostHandler({}, limiter);

      const res = await handler(postBody(body));

      expect(res.status).toBe(400);
      expect(service.setOrRotate).not.toHaveBeenCalled();
      expect(limiter.calls).toEqual(["check:post:admin-1", "fail:post:admin-1"]);
    },
  );

  it.each([
    { action: "set", username: "u", password: "p" },
    { bankCode: "popular", username: "u", password: "p" },
    { bankCode: "popular", action: "delete" },
    { bankCode: "popular", action: "set", password: "p" },
    { bankCode: "popular", action: "rotate", username: "u" },
    { username: {}, password: "p" },
    { username: "u", password: [] },
    { username: 123, password: "p" },
    { username: "u", password: false },
    { username: "   ", password: "p" },
    { username: "u", password: "   " },
  ])("rejects invalid POST body %#", async (body) => {
    const { handler, service } = makePostHandler();
    const payload = "bankCode" in body || "action" in body
      ? body
      : { bankCode: "popular", action: "set", ...body };
    const res = await handler(postBody(payload));

    expect(res.status).toBe(400);
    expect(service.setOrRotate).not.toHaveBeenCalled();
  });

  it.each(["set", "rotate"] as const)("returns success for %s action", async (action) => {
    const { handler, service } = makePostHandler({
      setOrRotate: vi.fn().mockResolvedValue({ bankCode: "popular", keyVersion: 1, action }),
    });

    const res = await handler(postBody({ bankCode: "popular", action, username: "user", password: "pass" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(service.setOrRotate).toHaveBeenCalledWith({ bankCode: "popular", username: "user", password: "pass" }, "admin-1");
    expect(body).toEqual({ message: "Credenciales actualizadas", bankCode: "popular", action, keyVersion: 1 });
  });

  it("returns success for test action", async () => {
    const { handler, service } = makePostHandler();

    const res = await handler(postBody({ bankCode: "popular", action: "test" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(service.validateStoredCredentialDecryption).toHaveBeenCalledWith("popular", "admin-1");
    expect(body).toEqual({ bankCode: "popular", outcome: "decrypted" });
  });

  it("does not echo credential material in responses", async () => {
    const { handler } = makePostHandler();
    const res1 = await handler(postBody({ bankCode: "popular", action: "set", username: "secret-user", password: "secret-pass" }));
    const s1 = JSON.stringify(await res1.json());
    expect(s1).not.toContain("secret-user");
    expect(s1).not.toContain("secret-pass");
    expect(s1).not.toContain("username");
    expect(s1).not.toContain("password");
    expect(s1).not.toContain("ciphertext");
    expect(s1).not.toContain("envelope");

    const res2 = await handler(postBody({ bankCode: "popular", action: "test" }));
    const s2 = JSON.stringify(await res2.json());
    expect(s2).not.toContain("username");
    expect(s2).not.toContain("password");
    expect(s2).not.toContain("ciphertext");
    expect(s2).not.toContain("envelope");
    expect(s2).not.toContain("keyMaterial");
  });

  it("masks service errors", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { handler: setHandler } = makePostHandler({
      setOrRotate: vi.fn().mockRejectedValue(new Error("DB connection lost")),
    });
    const res1 = await setHandler(postBody({ bankCode: "popular", action: "set", username: "u", password: "p" }));
    const body1 = await res1.json();
    expect(res1.status).toBe(503);
    expect(body1.error).toBe("Unable to process credential request");
    expect(JSON.stringify(body1)).not.toContain("DB connection lost");

    const { handler: testHandler } = makePostHandler({
      validateStoredCredentialDecryption: vi.fn().mockRejectedValue(new Error("SENSITIVE")),
    });
    const res2 = await testHandler(postBody({ bankCode: "popular", action: "test" }));
    const body2 = await res2.json();
    expect(res2.status).toBe(503);
    expect(JSON.stringify(body2)).not.toContain("SENSITIVE");
  });

  it("does not construct default deps before authz", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await withDatabaseUrlUnset(async () => {
      const req = new Request("http://localhost:3000/api/bank-credentials", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bankCode: "popular", action: "test" }),
      });
      const res = await POST(req);
      expect(res.status).toBe(401);
      expect(consoleSpy).not.toHaveBeenCalled();
    });
  });

  it.each([
    { action: "set", username: "u", password: "p" },
    { action: "test" },
  ])("masks default dependency failures for valid $action POST", async (body) => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await withDatabaseUrlUnset(async () => {
      const res = await POST(postBody({ bankCode: "popular", ...body }));
      const response = JSON.stringify(await res.json());
      const logs = serializedConsoleCalls(consoleSpy);

      expect(res.status).toBe(503);
      expect(response).toBe(JSON.stringify({ error: "Service unavailable" }));
      for (const unsafe of ["DATABASE_URL", "PostgreSQL", "connection string", "message", "stack"]) {
        expect(response).not.toContain(unsafe);
        expect(logs).not.toContain(unsafe);
      }
    });
  });
});
