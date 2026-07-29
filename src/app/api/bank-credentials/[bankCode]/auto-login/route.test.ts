import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InMemoryRateLimiter, type RateLimiter } from "../../../../../modules/auth/rate-limiter";
import { createPatchAutoLoginHandler, type PatchAutoLoginHandlerDeps } from "./route";

const adminHeaders = () => ({ "x-rd-sync-user-id": "admin-1", "x-rd-sync-role": "admin" });
const request = (body: string, headers: Record<string, string> = adminHeaders()) => new Request("http://localhost:3000/api/bank-credentials/popular/auto-login", {
  method: "PATCH", headers: { "content-type": "application/json", ...headers }, body,
});

function trackingLimiter(allowed = true): RateLimiter & { calls: string[] } {
  const calls: string[] = [];
  return { calls, check: (key) => { calls.push(`check:${key}`); return allowed ? { allowed: true } : { allowed: false, retryAfterSeconds: 30 }; }, recordFailure: (key) => calls.push(`fail:${key}`) };
}

function makeHandler(overrides: Partial<PatchAutoLoginHandlerDeps> = {}) {
  const setAutoLoginEnabledAndAudit = vi.fn().mockResolvedValue({ bankCode: "popular", autoLoginEnabled: true });
  const rateLimiter = trackingLimiter();
  const deps = { setAutoLoginEnabledAndAudit, rateLimiter, supportedBankCodes: ["popular"], ...overrides } satisfies PatchAutoLoginHandlerDeps;
  return { command: deps.setAutoLoginEnabledAndAudit, rateLimiter: deps.rateLimiter ?? rateLimiter, handler: createPatchAutoLoginHandler(deps) };
}

describe("PATCH /api/bank-credentials/[bankCode]/auto-login", () => {
  beforeEach(() => { process.env.RD_SYNC_TRUST_PROXY_HEADERS = "enabled"; });
  afterEach(() => { delete process.env.RD_SYNC_TRUST_PROXY_HEADERS; vi.restoreAllMocks(); });

  it.each<{ headers: Record<string, string>; status: number; body: { error: string } }>([{ headers: {}, status: 401, body: { error: "Authentication required" } }, { headers: { "x-rd-sync-user-id": "viewer-1", "x-rd-sync-role": "viewer" }, status: 403, body: { error: "Forbidden" } }])(
    "returns exact auth failure $status", async ({ headers, status, body }) => {
      const { handler, command, rateLimiter } = makeHandler();
      const response = await handler(request('{"enabled":true}', headers), "popular");
      expect({ status: response.status, body: await response.json(), calls: vi.mocked(command).mock.calls.length, rate: (rateLimiter as ReturnType<typeof trackingLimiter>).calls }).toEqual({ status, body, calls: 0, rate: [] });
    },
  );

  it.each(["not-json", "null", "[]", "{}", '{"enabled":"true"}', '{"enabled":true,"extra":false}'])(
    "rejects non-exact bodies before the atomic port: %s", async (body) => {
      const { handler, command } = makeHandler();
      const response = await handler(request(body), "popular");
      expect({ status: response.status, body: await response.json(), calls: vi.mocked(command).mock.calls.length }).toEqual({ status: 400, body: { error: "Invalid request body" }, calls: 0 });
    },
  );

  it("returns exact unsupported, missing, and atomic-failure responses", async () => {
    const unsupported = makeHandler();
    const missing = makeHandler({ setAutoLoginEnabledAndAudit: vi.fn().mockResolvedValue(null) });
    const failed = makeHandler({ setAutoLoginEnabledAndAudit: vi.fn().mockRejectedValue(new Error("password=unsafe")) });
    const responses = await Promise.all([
      unsupported.handler(request('{"enabled":true}'), "unknown-bank"),
      missing.handler(request('{"enabled":true}'), "popular"),
      failed.handler(request('{"enabled":true}'), "popular"),
    ]);
    await expect(Promise.all(responses.map(async (response) => ({ status: response.status, body: await response.json() })))).resolves.toEqual([
      { status: 404, body: { error: "Bank configuration not found" } },
      { status: 404, body: { error: "Auto-login configuration not found" } },
      { status: 503, body: { error: "Service unavailable" } },
    ]);
    expect(vi.mocked(unsupported.command)).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "delegates exact %s input and returns only state", async (enabled) => {
      const command = vi.fn().mockResolvedValue({ bankCode: "popular", autoLoginEnabled: enabled });
      const { handler } = makeHandler({ setAutoLoginEnabledAndAudit: command });
      const response = await handler(request(JSON.stringify({ enabled })), " popular ");
      expect({ body: await response.json(), input: command.mock.calls[0]?.[0] }).toEqual({ body: { bankCode: "popular", autoLoginEnabled: enabled }, input: { bankCode: "popular", enabled, adminId: "admin-1" } });
    },
  );

  it("uses one actor/action limiter bucket across supported banks", async () => {
    let now = 1_000;
    const rateLimiter = new InMemoryRateLimiter({ maxAttempts: 10, windowMs: 60_000, clock: () => now });
    const { handler, command } = makeHandler({ rateLimiter, supportedBankCodes: ["popular", "bhd"] });
    for (let index = 0; index < 10; index += 1) await expect(handler(request('{"enabled":true}'), index % 2 ? "bhd" : "popular")).resolves.toHaveProperty("status", 200);
    const blocked = await handler(request('{"enabled":true}'), "bhd");
    now += 60_000;
    const reset = await handler(request('{"enabled":true}'), "popular");
    expect({ blocked: [blocked.status, await blocked.json(), blocked.headers.get("Retry-After")], reset: reset.status, calls: vi.mocked(command).mock.calls.length }).toEqual({ blocked: [429, { error: "Rate limit exceeded" }, "60"], reset: 200, calls: 11 });
  });

  it("reports atomic failures through an injected safe reporter", async () => {
    const reporter = vi.fn();
    const deps = {
      setAutoLoginEnabledAndAudit: vi.fn().mockRejectedValue(new Error("password=unsafe")),
      rateLimiter: trackingLimiter(), supportedBankCodes: ["popular"], reportAtomicToggleFailure: reporter,
    } as unknown as PatchAutoLoginHandlerDeps;
    const response = await createPatchAutoLoginHandler(deps)(request('{"enabled":true}'), "popular");
    expect({ status: response.status, body: await response.json(), report: reporter.mock.calls[0]?.[0] }).toEqual({
      status: 503, body: { error: "Service unavailable" }, report: { requestId: expect.any(String), bankCode: "popular", attemptedEnabled: true, stage: "atomic_toggle_failed" },
    });
  });
});
