import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const repository = vi.hoisted(() => ({
  findByBankCode: vi.fn(),
  resolveConsumerManualRecovery: vi.fn(),
}));
const getPrismaClient = vi.hoisted(() => vi.fn(() => ({})));

vi.mock("../../../../modules/persistence/prisma-client", () => ({ getPrismaClient }));
vi.mock("../../../../modules/persistence/prisma-bank-session-expiry-episode-repository", () => ({
  PrismaBankSessionExpiryEpisodeRepository: class {
    findByBankCode = repository.findByBankCode;
    resolveConsumerManualRecovery = repository.resolveConsumerManualRecovery;
  },
}));

import { GET, POST } from "./route";

function adminHeaders(): Record<string, string> {
  return { "x-rd-sync-user-id": "admin-1", "x-rd-sync-role": "admin" };
}

function episode(state: "manual_recovery_required" | "resolved" = "manual_recovery_required") {
  return {
    bankCode: "popular",
    expiredEventId: "event-1",
    runId: "run-1",
    publicationClaimToken: "publication-token",
    consumerClaimToken: "consumer-token",
    consumerAttemptState: state,
  };
}

function request(method: "GET" | "POST", headers: Record<string, string> = adminHeaders(), body?: unknown): Request {
  return new Request("http://localhost:3000/api/bank-sessions/manual-recovery?bankCode=popular", {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("/api/bank-sessions/manual-recovery", () => {
  beforeEach(() => {
    process.env.RD_SYNC_TRUST_PROXY_HEADERS = "enabled";
    repository.findByBankCode.mockReset().mockResolvedValue(episode());
    repository.resolveConsumerManualRecovery.mockReset().mockResolvedValue({ id: "resolution-1" });
  });

  afterEach(() => {
    delete process.env.RD_SYNC_TRUST_PROXY_HEADERS;
    vi.restoreAllMocks();
  });

  it.each([{}, { "x-rd-sync-user-id": "viewer-1", "x-rd-sync-role": "viewer" }])("rejects non-admin callers before looking up an episode", async (headers) => {
    const response = await GET(request("GET", headers as Record<string, string>));

    expect(response.status).toBe(Object.keys(headers).length ? 403 : 401);
    expect(repository.findByBankCode).not.toHaveBeenCalled();
  });

  it("reports eligibility without exposing episode identifiers or claim tokens", async () => {
    const response = await GET(request("GET"));
    const body = JSON.stringify(await response.json());

    expect(response.status).toBe(200);
    expect(body).toBe(JSON.stringify({ eligible: true }));
    expect(body).not.toContain("event-1");
    expect(body).not.toContain("token");
  });

  it("reports a non-eligible episode without offering its durable state to the browser", async () => {
    repository.findByBankCode.mockResolvedValue(episode("resolved"));

    const response = await GET(request("GET"));

    expect(await response.json()).toEqual({ eligible: false });
  });

  it("resolves an eligible episode as the authenticated admin and returns only a safe status", async () => {
    const response = await POST(request("POST", adminHeaders(), {
      decision: { outcome: "safe_to_retry", reason: "verified_no_mutation" },
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "resolved" });
    expect(repository.resolveConsumerManualRecovery).toHaveBeenCalledWith(
      expect.objectContaining({ bankCode: "popular", expiredEventId: "event-1", runId: "run-1", token: "publication-token" }),
      "consumer-token",
      { operatorId: "admin-1", decision: { outcome: "safe_to_retry", reason: "verified_no_mutation" } },
    );
  });

  it("rejects non-eligible and concurrent resolution attempts without writing", async () => {
    const body = { decision: { outcome: "resolved_no_retry", reason: "closed_without_retry" } };
    repository.findByBankCode.mockResolvedValue(episode("resolved"));

    await expect(POST(request("POST", adminHeaders(), body))).resolves.toHaveProperty("status", 409);
    expect(repository.resolveConsumerManualRecovery).not.toHaveBeenCalled();

    repository.findByBankCode.mockResolvedValue(episode());
    repository.resolveConsumerManualRecovery.mockResolvedValue(null);
    await expect(POST(request("POST", adminHeaders(), body))).resolves.toHaveProperty("status", 409);
  });

  it("linearizes concurrent resolution requests into one success and one conflict", async () => {
    repository.resolveConsumerManualRecovery.mockResolvedValueOnce({ id: "resolution-1" }).mockResolvedValueOnce(null);
    const body = { decision: { outcome: "safe_to_retry", reason: "verified_no_mutation" } };

    const results = await Promise.all([POST(request("POST", adminHeaders(), body)), POST(request("POST", adminHeaders(), body))]);

    expect(results.map((response) => response.status).sort()).toEqual([200, 409]);
  });

  it("fails closed with a generic response when persistence fails", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    repository.findByBankCode.mockRejectedValue(new Error("database token=secret"));

    const response = await GET(request("GET"));
    const body = JSON.stringify(await response.json());

    expect(response.status).toBe(503);
    expect(body).toBe(JSON.stringify({ error: "Manual recovery is unavailable" }));
    expect(body).not.toContain("database");
    expect(body).not.toContain("secret");
    expect(consoleSpy).toHaveBeenCalledOnce();
  });
});
