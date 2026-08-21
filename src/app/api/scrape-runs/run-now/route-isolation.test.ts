import { afterEach, describe, expect, it, vi } from "vitest";

const request = () => new Request("http://localhost/api/scrape-runs/run-now", { method: "POST", headers: { "x-rd-sync-user-id": "operator-1", "x-rd-sync-role": "viewer" } });
describe("run-now route activation isolation", () => {
  afterEach(() => { delete process.env.RD_SYNC_AUTHENTICATED_INGESTION; delete process.env.RD_SYNC_REDIS_URL; delete process.env.RD_SYNC_TRUST_PROXY_HEADERS; vi.doUnmock("./route-runtime"); vi.resetModules(); });
  it("refuses enabled without Redis without evaluating runtime boundaries", async () => {
    process.env.RD_SYNC_AUTHENTICATED_INGESTION = "enabled"; process.env.RD_SYNC_TRUST_PROXY_HEADERS = "enabled";
    const forbidden = ["./route-runtime", "../run-now", "../../defaults", "../../audit/defaults", "../consumer-defaults", "../../../../modules/bank-adapters/registry", "../../../../worker/scraper/browser-runtime"];
    const evaluations = new Map(forbidden.map((path) => [path, 0]));
    for (const path of forbidden) vi.doMock(path, () => { evaluations.set(path, evaluations.get(path)! + 1); throw new Error(`evaluated ${path}`); });
    try { const { POST } = await import("./route"); const response = await POST(request()); expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: "Unable to schedule run" }); expect([...evaluations.values()]).toEqual(forbidden.map(() => 0)); }
    finally { for (const path of forbidden) vi.doUnmock(path); }
  });
  it("returns generic 401 before selection or runtime loading", async () => {
    process.env.RD_SYNC_AUTHENTICATED_INGESTION = "enabled"; let loads = 0;
    vi.doMock("./route-runtime", () => { loads += 1; throw new Error("must not load"); });
    const { POST } = await import("./route"); const response = await POST(new Request("http://localhost/api/scrape-runs/run-now", { method: "POST" }));
    expect(response.status).toBe(401); expect(await response.json()).toEqual({ error: "Unable to schedule run" }); expect(loads).toBe(0);
  });
  it("shares one runtime module across concurrent valid requests", async () => {
    process.env.RD_SYNC_AUTHENTICATED_INGESTION = "enabled"; process.env.RD_SYNC_REDIS_URL = "redis://worker"; process.env.RD_SYNC_TRUST_PROXY_HEADERS = "enabled";
    let modules = 0; let calls = 0;
    vi.doMock("./route-runtime", () => { modules += 1; return { postDefaultScrapeRunNow: async () => { calls += 1; return Response.json({}, { status: 202 }); } }; });
    const { POST } = await import("./route"); const [first, second] = await Promise.all([POST(request()), POST(request())]);
    expect([first.status, second.status]).toEqual([202, 202]); expect(modules).toBe(1); expect(calls).toBe(2);
  });
});
